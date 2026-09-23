import { requireAdminAccess } from "./audit-routes.mjs";
import { HttpError } from "./http-error.mjs";
import { requireTrustedOrigin } from "./origin-policy.mjs";
import { sendJson } from "./respond.mjs";
import { JobNotRetryableError, OperationsCursorError, OperationsJobNotFoundError } from "../storage/operations-store.mjs";

function limit(searchParams) {
  const raw=searchParams.get("limit"); if (!raw) return 20;
  const value=Number(raw); if (!Number.isInteger(value)||value<1||value>50) throw new HttpError(400,"Limit must be between 1 and 50.","INVALID_LIMIT");
  return value;
}

export function handleOperationsApi({request,response,config,url,operationsStore,apiMetrics}) {
  if (!/^\/api\/operations(?:\/|$)/.test(url.pathname)) return false;
  response.setHeader("Cache-Control","private, no-store");
  requireAdminAccess(request,config);
  if (request.method==="GET" && url.pathname==="/api/operations") return sendJson(response,200,operationsStore.snapshot({api:apiMetrics.snapshot()}));
  try {
    if (request.method==="GET" && url.pathname==="/api/operations/failed") {
      const page=operationsStore.listFailed({limit:limit(url.searchParams),cursor:url.searchParams.get("cursor")});
      return sendJson(response,200,{jobs:page.items,page:{nextCursor:page.nextCursor}});
    }
    if (request.method==="GET" && url.pathname==="/api/operations/audit-log") {
      const page=operationsStore.listAuditLog({limit:limit(url.searchParams),cursor:url.searchParams.get("cursor")});
      return sendJson(response,200,{entries:page.items,page:{nextCursor:page.nextCursor}});
    }
    const retry=/^\/api\/operations\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
    if (request.method==="POST" && retry) {
      requireTrustedOrigin(request,config.publicOrigin);
      const job=operationsStore.retryJob({jobId:retry[1],requestId:request.requestId});
      return sendJson(response,202,{job});
    }
  } catch (error) {
    if (error instanceof OperationsCursorError) throw new HttpError(400,"Cursor is invalid.","INVALID_CURSOR");
    if (error instanceof OperationsJobNotFoundError) throw new HttpError(404,"Operation job was not found.","OPERATION_JOB_NOT_FOUND");
    if (error instanceof JobNotRetryableError) throw new HttpError(409,"Job is no longer retryable.","JOB_NOT_RETRYABLE");
    throw error;
  }
  throw new HttpError(405,"Method is not allowed for this endpoint.","METHOD_NOT_ALLOWED");
}
