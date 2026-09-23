import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { createOperationsStore, JobNotRetryableError, OperationsCursorError, OperationsJobNotFoundError } from "../src/storage/operations-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";
import { createAuditJobStore } from "../src/storage/audit-job-store.mjs";

const dirs = [];
const now = "2026-09-23T12:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "noqori-operations-")); dirs.push(dir);
  const databaseFilePath = join(dir, "db.sqlite"); runMigrations(databaseFilePath);
  return { databaseFilePath, store: createOperationsStore(databaseFilePath, { clock: () => new Date(now), idGenerator: () => "log-1" }) };
}
function db(path, callback) { const database = new DatabaseSync(path); database.exec("PRAGMA foreign_keys=ON"); try { return callback(database); } finally { database.close(); } }
function user(database, id, { plan="free", disabled=null, deletion=null }={}) { database.prepare(`INSERT INTO users (id,email_original,email_normalized,password_hash,created_at,updated_at,disabled_at,deletion_requested_at,plan_code) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,`${id}@private.test`,`${id}@private.test`,"x".repeat(64),now,now,disabled,deletion,plan); }
function job(database, id, status, owner="active", overrides={}) { const running=status==="running"; database.prepare(`INSERT INTO audit_jobs (id,status,normalized_url,attempt_count,max_attempts,available_at,created_at,updated_at,user_id,failed_at,error_code,error_message,worker_id,lease_token,lease_expires_at,started_at,plan_code_snapshot,quota_period_start,quota_charged) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,status,`https://${id}.private.test`,overrides.attemptCount??2,2,now,overrides.createdAt??now,now,owner,overrides.failedAt??(status==="failed"?now:null),status==="failed"?"AUDIT_FAILED":null,status==="failed"?"private error":null,running?"worker":null,running?"lease":null,running?now:null,running?now:null,overrides.plan??"free","2026-09-01T00:00:00.000Z",overrides.charged??0); }
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));

describe("operations store",()=>{
  it("returns privacy-safe user and current-month quota aggregates",()=>{
    const {databaseFilePath,store}=fixture(); db(databaseFilePath,d=>{ user(d,"active"); user(d,"pro",{plan:"pro"}); user(d,"disabled",{disabled:now}); user(d,"pending",{deletion:now}); d.prepare("INSERT INTO audit_monthly_usage VALUES (?,?,?)").run("active","2026-09-01T00:00:00.000Z",3); d.prepare("INSERT INTO audit_monthly_usage VALUES (?,?,?)").run("pro","2026-09-01T00:00:00.000Z",7); });
    const result=store.snapshot({api:{requests:4,errors:1,dbErrors:0,latencyAvgMs:10,latencyMaxMs:20,windowMs:900000}});
    assert.deepEqual(result.users,{active:2,free:1,pro:1,deletionPending:1,disabled:1});
    assert.deepEqual(result.quota,{periodStart:"2026-09-01T00:00:00.000Z",resetsAt:"2026-10-01T00:00:00.000Z",totalUsed:10,freeUsed:3,proUsed:7,usersAtLimit:1});
    assert.doesNotMatch(JSON.stringify(result),/@private|https:/);
  });

  it("lists only failed jobs newest first with opaque keyset pagination and safe fields",()=>{
    const {databaseFilePath,store}=fixture(); db(databaseFilePath,d=>{user(d,"active"); job(d,"f1","failed","active",{failedAt:"2026-09-23T10:00:00.000Z"}); job(d,"f2","failed","active",{failedAt:"2026-09-23T11:00:00.000Z"}); job(d,"q","queued");});
    const first=store.listFailed({limit:1}); assert.equal(first.items[0].id,"f2"); assert.ok(first.nextCursor);
    const second=store.listFailed({limit:1,cursor:first.nextCursor}); assert.equal(second.items[0].id,"f1");
    assert.deepEqual(Object.keys(first.items[0]),["id","createdAt","failedAt","attemptCount","maxAttempts","errorCode","planCode","requestId"]);
    assert.throws(()=>store.listFailed({cursor:"bad"}),OperationsCursorError);
  });

  it("atomically requeues one failed job, preserves ownership/plan/quota, and logs success",()=>{
    const {databaseFilePath,store}=fixture(); db(databaseFilePath,d=>{user(d,"active",{plan:"pro"}); job(d,"failed","failed","active",{plan:"pro",charged:0});});
    assert.deepEqual(store.retryJob({jobId:"failed",requestId:"123e4567-e89b-42d3-a456-426614174000"}),{id:"failed",status:"queued"});
    assert.throws(()=>store.retryJob({jobId:"failed"}),JobNotRetryableError);
    const state=db(databaseFilePath,d=>({job:d.prepare("SELECT * FROM audit_jobs WHERE id='failed'").get(),logs:d.prepare("SELECT * FROM admin_operation_log").all()}));
    assert.equal(state.job.attempt_count,0); assert.equal(state.job.worker_id,null); assert.equal(state.job.error_message,null); assert.equal(state.job.user_id,"active"); assert.equal(state.job.plan_code_snapshot,"pro"); assert.equal(state.job.quota_charged,0); assert.equal(state.logs.length,1); assert.equal(state.logs[0].action,"job.retry");
    const claimed=createAuditJobStore(databaseFilePath,{clock:()=>new Date(now),leaseTokenGenerator:()=>"lease-new"}).claimNext({workerId:"worker-new",leaseMs:1000});
    assert.equal(claimed.id,"failed");
  });

  it("rejects unknown, non-failed, disabled and deletion-pending owners",()=>{
    const {databaseFilePath,store}=fixture(); db(databaseFilePath,d=>{user(d,"active");user(d,"disabled",{disabled:now});user(d,"pending",{deletion:now});job(d,"queued","queued");job(d,"running","running");job(d,"disabled-job","failed","disabled");job(d,"pending-job","failed","pending");});
    assert.throws(()=>store.retryJob({jobId:"missing"}),OperationsJobNotFoundError);
    for(const id of ["queued","running","disabled-job","pending-job"]) assert.throws(()=>store.retryJob({jobId:id}),JobNotRetryableError);
  });

  it("rejects a completed job with a report",()=>{
    const {databaseFilePath,store}=fixture(); db(databaseFilePath,d=>{user(d,"active");d.prepare(`INSERT INTO audits (id,created_at,updated_at,normalized_url,domain,overall_score,scanner_mode,report_json,user_id,expires_at) VALUES ('report',?,?,?,?,80,'html','{}','active',?)`).run(now,now,"https://private.test","private.test","2026-10-23T12:00:00.000Z");d.prepare(`INSERT INTO audit_jobs (id,status,normalized_url,audit_id,attempt_count,max_attempts,available_at,created_at,updated_at,completed_at,user_id) VALUES ('completed','completed','https://private.test','report',1,2,?,?,?,?,?)`).run(now,now,now,now,"active");});
    assert.throws(()=>store.retryJob({jobId:"completed"}),JobNotRetryableError);
  });
});
