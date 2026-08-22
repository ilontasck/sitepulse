const input = document.getElementById("urlInput");
const form = document.getElementById("auditForm");
const errorBox = document.getElementById("errorBox");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loadingText");
const report = document.getElementById("report");
const authPanel = document.getElementById("authPanel");
const authLoading = document.getElementById("authLoading");
const authError = document.getElementById("authError");
const signedOutView = document.getElementById("signedOutView");
const signedInView = document.getElementById("signedInView");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const registrationArea = document.getElementById("registrationArea");
const registrationTemplate = document.getElementById("registrationTemplate");
const closedRegistration = document.getElementById("closedRegistration");
const sessionEmail = document.getElementById("sessionEmail");
const logoutButton = document.getElementById("logoutButton");
let currentUser = null;
let registrationMode = "closed";

function validPublicUser(user) {
  return user && typeof user.id === "string" && typeof user.email === "string" && typeof user.createdAt === "string";
}

function hideAuthError() {
  authError.hidden = true;
  authError.textContent = "";
}

function showAuthError(message, { focusLogin = false } = {}) {
  authError.textContent = message;
  authError.hidden = false;
  if (focusLogin) loginEmail.focus();
}

function setAuthFormBusy(authForm, busy) {
  for (const control of authForm.elements) control.disabled = busy;
  authForm.setAttribute("aria-busy", String(busy));
}

function configureRegistration(mode) {
  registrationMode = mode === "public" ? "public" : "closed";
  registrationArea.replaceChildren();
  closedRegistration.hidden = registrationMode === "public";

  if (registrationMode === "public") {
    registrationArea.append(registrationTemplate.content.cloneNode(true));
    document.getElementById("registerForm").addEventListener("submit", handleRegister);
  }
}

function showAuthenticated(user) {
  currentUser = user;
  hideAuthError();
  authLoading.hidden = true;
  signedOutView.hidden = true;
  signedInView.hidden = false;
  sessionEmail.textContent = user.email;
  form.hidden = false;
}

function showSignedOut({ message = "", focusLogin = false } = {}) {
  currentUser = null;
  cancelActiveAuditRun();
  analysisExperience?.reset();
  authLoading.hidden = true;
  signedInView.hidden = true;
  signedOutView.hidden = false;
  form.hidden = true;
  report.hidden = true;
  document.getElementById("landing").hidden = false;
  document.body.classList.remove("noqori-report-view");
  if (message) showAuthError(message, { focusLogin });
  else hideAuthError();
}

async function parseAuthResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function authFailureMessage(action, response) {
  if (action === "login" && response.status === 401) return "Email or password is incorrect.";
  if (action === "register" && response.status === 409) return "Registration could not be completed. Please try again.";
  if (action === "register" && response.status === 400) return "Check your email and use a password of at least 12 characters.";
  if (response.status === 429) return "Too many attempts. Please wait before trying again.";
  if (response.status === 503) return "Account access is temporarily unavailable. Please try again shortly.";
  return action === "login"
    ? "We could not sign you in. Please try again."
    : "Registration could not be completed. Please try again.";
}

async function submitCredentials(authForm, action) {
  hideAuthError();
  const values = new FormData(authForm);
  setAuthFormBusy(authForm, true);
  let focusLoginOnFailure = false;

  try {
    const response = await fetch(`/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: values.get("email"), password: values.get("password") })
    });
    const payload = await parseAuthResponse(response);

    if (!response.ok || !validPublicUser(payload?.user)) {
      if (action === "register" && response.status === 403) {
        configureRegistration("closed");
        throw new Error("Registration is currently closed.");
      }
      throw new Error(authFailureMessage(action, response));
    }

    authForm.reset();
    showAuthenticated(payload.user);
    input.focus();
  } catch (error) {
    const message = error instanceof TypeError
      ? "Account access is unavailable. Please try again shortly."
      : error.message;
    focusLoginOnFailure = action === "login";
    showAuthError(message);
  } finally {
    setAuthFormBusy(authForm, false);
    if (focusLoginOnFailure) loginEmail.focus();
  }
}

function handleRegister(event) {
  event.preventDefault();
  return submitCredentials(event.currentTarget, "register");
}

loginForm.addEventListener("submit", event => {
  event.preventDefault();
  void submitCredentials(loginForm, "login");
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  hideAuthError();
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    if (!response.ok) throw new Error();
    showSignedOut({ focusLogin: true });
  } catch {
    showAuthError("We could not sign you out. Please try again.");
  } finally {
    logoutButton.disabled = false;
  }
});

async function restoreSession() {
  authPanel.setAttribute("aria-busy", "true");
  try {
    const [configResponse, sessionResponse] = await Promise.all([
      fetch("/api/auth/config"),
      fetch("/api/auth/me")
    ]);
    const configPayload = await parseAuthResponse(configResponse);
    configureRegistration(configResponse.ok ? configPayload?.registrationMode : "closed");

    if (sessionResponse.ok) {
      const sessionPayload = await parseAuthResponse(sessionResponse);
      if (!validPublicUser(sessionPayload?.user)) throw new Error();
      showAuthenticated(sessionPayload.user);
    } else if (sessionResponse.status === 401) {
      showSignedOut();
    } else {
      showSignedOut({ message: "We could not check your session. Please try signing in." });
    }
  } catch {
    configureRegistration("closed");
    showSignedOut({ message: "We could not check your session. Please try signing in." });
  } finally {
    authPanel.setAttribute("aria-busy", "false");
  }
}

function requireFreshSession(response) {
  if (response.status !== 401) return;
  showSignedOut({ message: "Your session expired. Sign in again.", focusLogin: true });
  throw createPublicError("Your session expired. Sign in again.", "AUTHENTICATION_REQUIRED");
}

const analysisExperience = window.NOQORIAnalysisExperience.create({
  input,
  onStop() {
    cancelActiveAuditRun();
    loading.hidden = true;
    loadingText.textContent = "Starting your audit…";
    document.getElementById("runBtn").disabled = false;
  }
});
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_WAIT_MS = 90000;
const POLL_MAX_NETWORK_FAILURES = 3;
let activeAuditRun = null;
function setExample(value) { input.value = value; input.focus(); }
function isBlockedClientHost(hostname) {
  const host = hostname.toLowerCase();
  const ipv4Parts = host.split(".").map(part => Number(part));

  if (host === "localhost" || host === "0.0.0.0" || host === "127.0.0.1" || host === "::1") {
    return true;
  }

  if (ipv4Parts.length === 4 && ipv4Parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = ipv4Parts;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  return false;
}
function validateClientUrl(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "Website URL is required.";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);

    if (!parsed.hostname.includes(".") || parsed.hostname.includes(" ")) {
      return "Use a public website domain, like example.com.";
    }

    if (isBlockedClientHost(parsed.hostname)) {
      return "Private or internal website addresses cannot be scanned.";
    }
  } catch {
    return "Use a valid website address, like studio.example.com.";
  }

  return "";
}
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function toReportViewModel(audit) {
  return {
    id: audit.id,
    domain: audit.domain,
    normalizedUrl: audit.normalizedUrl,
    overall: audit.overallScore,
    cats: audit.categories.map(category => ({
      id: category.id,
      name: category.label,
      score: category.score,
      text: category.explanation,
      recs: category.recommendations || [],
      recommendationDetails: category.recommendationDetails || [],
      checks: category.checks || [],
      status: category.status,
      impact: category.impact
    })),
    recommendations: audit.recommendations || [],
    priorityFixes: audit.priorityFixes || [],
    signals: audit.signals || {},
    scanner: audit.scanner || { mode: "unknown", adapters: [], warnings: [] },
    checkedAt: audit.scanner?.checkedAt || null,
    warnings: audit.warnings || audit.scanner?.warnings || []
  };
}
function isAbortError(error) {
  return error?.name === "AbortError";
}
function createPublicError(message, code = "") {
  const error = new Error(message);
  error.code = code;
  return error;
}
function assertActiveRun(run) {
  if (run.controller.signal.aborted || activeAuditRun !== run) {
    throw new DOMException("Audit polling was superseded.", "AbortError");
  }
}
function cancelActiveAuditRun() {
  if (activeAuditRun) {
    activeAuditRun.controller.abort();
    activeAuditRun = null;
  }
}
async function requestAudit(websiteUrl, { signal } = {}) {
  let response;

  try {
    response = await fetch("/api/audits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl }),
      signal
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw createPublicError("The NOQORI audit service is unavailable. Please try again shortly.", "AUDIT_SERVICE_UNAVAILABLE");
  }

  requireFreshSession(response);

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error("NOQORI received an invalid server response. Please try again.");
  }

  if (!response.ok) {
    throw createPublicError(payload.error?.message || "Audit request failed.", payload.error?.code);
  }

  if (!payload.job?.statusUrl || payload.job.status !== "queued") {
    throw new Error("NOQORI received an invalid server response. Please try again.");
  }

  return payload.job;
}
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Audit polling was superseded.", "AbortError"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function fetchAuditReport(auditUrl, { signal } = {}) {
  let response;

  try {
    response = await fetch(auditUrl, { signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error("The audit finished, but the report could not be loaded. Please try again.");
  }

  requireFreshSession(response);

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error("The audit finished, but the report could not be loaded. Please try again.");
  }

  if (!response.ok || !payload.audit) {
    throw new Error(payload.error?.message || "The audit finished, but the report could not be loaded. Please try again.");
  }

  return payload.audit;
}
async function pollAuditJob(statusUrl, options = {}) {
  const intervalMs = options.intervalMs || POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs || POLL_MAX_WAIT_MS;
  const parentSignal = options.signal;
  const isCurrent = options.isCurrent || (() => true);
  const onStatus = options.onStatus || (() => {});
  const pollingController = new AbortController();
  let deadlineReached = false;
  let consecutiveNetworkFailures = 0;
  const onParentAbort = () => pollingController.abort();
  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    pollingController.abort();
  }, maxWaitMs);

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const signal = pollingController.signal;

  try {
    while (true) {
      await wait(intervalMs, signal);

      if (signal.aborted || !isCurrent()) {
        throw new DOMException("Audit polling was superseded.", "AbortError");
      }

      let response;

      try {
        response = await fetch(statusUrl, { signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        consecutiveNetworkFailures += 1;

        if (consecutiveNetworkFailures >= POLL_MAX_NETWORK_FAILURES) {
          throw createPublicError("NOQORI could not check the audit status. Please try again.", "AUDIT_STATUS_UNAVAILABLE");
        }

        loadingText.textContent = "Reconnecting to audit status…";
        onStatus("reconnecting");
        continue;
      }

      requireFreshSession(response);

      consecutiveNetworkFailures = 0;

      let payload;

      try {
        payload = await response.json();
      } catch {
        throw new Error("NOQORI received an invalid audit status. Please try again.");
      }

      if (signal.aborted || !isCurrent()) {
        throw new DOMException("Audit polling was superseded.", "AbortError");
      }

      if (!response.ok || !payload.job?.status) {
        throw new Error(payload.error?.message || "NOQORI received an invalid audit status. Please try again.");
      }

      if (payload.job.status === "queued") {
        loadingText.textContent = "Your audit is queued…";
        onStatus("queued");
        continue;
      }

      if (payload.job.status === "running") {
        loadingText.textContent = "Analyzing your website…";
        onStatus("running");
        continue;
      }

      if (payload.job.status === "completed" && payload.job.auditUrl) {
        clearTimeout(deadlineTimer);
        onStatus("building");
        return fetchAuditReport(payload.job.auditUrl, { signal });
      }

      if (payload.job.status === "failed") {
        throw createPublicError(
          payload.job.error?.message || "The website could not be audited. Please try again.",
          payload.job.error?.code
        );
      }

      throw new Error("NOQORI received an invalid audit status. Please try again.");
    }
  } catch (error) {
    if (isAbortError(error) && deadlineReached && !parentSignal?.aborted && isCurrent()) {
      throw new Error("The audit is taking longer than expected. Please try again shortly.");
    }

    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
function statusTone(status, score) {
  if (score >= 78 || status === "Excellent" || status === "Strong") return "good";
  if (score >= 58 || status === "Needs work") return "warning";
  return "critical";
}
function scoreStatusLabel(score) {
  if (score >= 78) return "Strong";
  if (score >= 58) return "Needs improvement";
  return "Poor";
}
function overallSummary(score) {
  if (score >= 78) return "A strong foundation with focused opportunities to improve.";
  if (score >= 58) return "A workable foundation with important issues to address.";
  return "Significant issues need attention before this page reaches a strong baseline.";
}
function scannerLabel(mode) {
  if (mode === "html-real-checks") return "HTML real checks";
  if (mode === "fallback") return "Fallback scanner";
  return mode || "Unknown scanner";
}
function scannerStatus(status) {
  const statuses = {
    "full-rendered-completed": ["Full rendered audit completed", "good"],
    "rendered-audit-temporarily-unavailable": ["Rendered audit temporarily unavailable", "warning"],
    "rendered-audit-timed-out": ["Rendered audit timed out", "warning"],
    "partial-audit-completed": ["Partial audit completed", "warning"],
    "html-fallback-used": ["HTML fallback used", "warning"],
    "html-audit-completed": ["HTML audit completed", "good"]
  };
  const [label, tone] = statuses[status] || ["Audit completed", "good"];
  return `<span class="nqReportState" data-tone="${tone}"><i aria-hidden="true"></i>${escapeHtml(label)}</span>`;
}
function priorityRank(priority) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}
function priorityText(priority) {
  if (priority === "high") return "High priority";
  if (priority === "medium") return "Medium priority";
  return "Low priority";
}
function categoryFor(result, name) {
  return result.cats.find(category => category.name === name) || null;
}
function firstFailedEvidence(category) {
  const failed = category?.checks?.find(check => !check.passed);

  if (!failed) return category ? `Category score: ${category.score}/100.` : "No check-level evidence was available.";
  return `${failed.label}${failed.details ? ` ${failed.details}.` : ""}`;
}
function buildPriorityRecommendations(result) {
  const fromCategories = result.cats.flatMap(category =>
    category.recs.map((text, index) => ({
      category: category.name,
      text,
      priority: category.recommendationDetails[index]?.priority || (category.score < 64 ? "high" : category.score < 78 ? "medium" : "low"),
      categoryModel: category
    }))
  );
  const fromTop = result.recommendations.map(item => ({
    category: item.category,
    text: item.text,
    priority: item.priority || "medium",
    categoryModel: categoryFor(result, item.category)
  }));
  const seen = new Set();

  return [...fromTop, ...fromCategories]
    .filter(item => {
      const key = `${item.category}:${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a,b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, 10);
}
function renderAdapters(adapters) {
  return (adapters || []).map(adapter => `<span>${escapeHtml(adapter)}</span>`).join("");
}
function renderWarnings(warnings) {
  if (!warnings?.length) return "";
  return `<div class="nqReportWarnings"><b>Audit notices</b>${warnings.map(warning => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`;
}
function renderCheckRows(checks, state) {
  return checks.map(check => `
    <div class="nqEvidenceRow" data-check-state="${state}">
      <span class="nqEvidenceIcon" aria-hidden="true">${state === "passed" ? "✓" : "!"}</span>
      <div>
        <b>${escapeHtml(check.label)}</b>
        <p><span>${state === "passed" ? "Passed" : "Needs work"}</span><span>${escapeHtml(priorityText(check.priority || "medium"))}</span>${check.details ? `<span>${escapeHtml(check.details)}</span>` : ""}</p>
      </div>
    </div>
  `).join("");
}
function renderCategory(category) {
  const passed = (category.checks || []).filter(check => check.passed);
  const failed = (category.checks || []).filter(check => !check.passed);
  const tone = statusTone(category.status, category.score);

  return `
    <details class="nqCategory" id="category-${escapeHtml(category.id)}" ${category.score < 58 ? "open" : ""}>
      <summary>
        <span class="nqCategoryIdentity"><small>${escapeHtml(category.id.toUpperCase())}</small><b>${escapeHtml(category.name)}</b></span>
        <span class="nqCategorySummary"><span>${category.recs.length} recommendations</span><strong>${category.score}</strong><em data-tone="${tone}">${escapeHtml(category.status)}</em></span>
      </summary>
      <div class="nqCategoryBody">
        <div class="nqCategoryIntro">
          <p>${escapeHtml(category.text)}</p>
          <div><span>Score <b>${category.score}/100</b></span><span>Needs work <b>${failed.length}</b></span><span>Passed <b>${passed.length}</b></span></div>
        </div>
        ${failed.length ? `
          <section class="nqCategoryEvidence" aria-labelledby="${escapeHtml(category.id)}-evidence-title">
            <h4 id="${escapeHtml(category.id)}-evidence-title">Evidence to review</h4>
            ${renderCheckRows(failed, "failed")}
          </section>
        ` : (category.checks || []).length ? `<p class="nqNoIssues">No failed live checks in this category.</p>` : `<p class="nqUnavailableInline">Live check evidence was unavailable; this category uses fallback heuristics.</p>`}
        <section class="nqCategoryActions" aria-labelledby="${escapeHtml(category.id)}-actions-title">
          <h4 id="${escapeHtml(category.id)}-actions-title">Recommended actions</h4>
          <ol>${category.recs.map((recommendation, index) => `<li><span class="nqPriorityTag" data-priority="${escapeHtml(category.recommendationDetails[index]?.priority || "medium")}">${escapeHtml(priorityText(category.recommendationDetails[index]?.priority || "medium"))}</span><p>${escapeHtml(recommendation)}</p></li>`).join("")}</ol>
        </section>
        ${passed.length ? `<details class="nqPassedChecks"><summary>Passed checks <span>${passed.length}</span></summary><div>${renderCheckRows(passed, "passed")}</div></details>` : ""}
      </div>
    </details>
  `;
}
function renderCategoryNavigation(result) {
  return `
    <nav class="nqCategoryNav" aria-label="Audit categories">
      ${result.cats.map(category => `<a href="#category-${escapeHtml(category.id)}"><span>${escapeHtml(category.name)}</span><b>${category.score}</b><i data-tone="${statusTone(category.status, category.score)}" aria-hidden="true"></i></a>`).join("")}
    </nav>
  `;
}
function buildPriorityFindings(result) {
  if (result.priorityFixes.length) {
    return result.priorityFixes.slice(0, 3).map(fix => ({
      ...fix,
      categoryModel: categoryFor(result, fix.category)
    }));
  }

  return [...result.cats].sort((first, second) => first.score - second.score).slice(0, 3).map(category => ({
    title: category.recs[0] || category.text,
    category: category.name,
    priority: category.recommendationDetails[0]?.priority || (category.score < 58 ? "high" : "medium"),
    impact: category.impact || "Medium",
    description: category.text,
    categoryModel: category
  }));
}
function renderPriorityFindings(result) {
  const findings = buildPriorityFindings(result);

  return `
    <section class="nqPrioritySection" aria-labelledby="priorityTitle">
      <div class="nqPriorityDecor" aria-hidden="true"><img src="/assets/noqori/noqori-expressive-prototype.png" alt="" /></div>
      <header class="nqReportSectionHeader nqPriorityHeader">
        <div><p class="nqReportLabel"><span aria-hidden="true"></span>WHAT MATTERS MOST</p><h2 id="priorityTitle">Your top 3 next actions.</h2></div>
        <p>Three actions, ordered by recommendation priority and weakest category score. Each one links to the evidence behind it.</p>
      </header>
      <div class="nqPriorityList">
        ${findings.map((finding, index) => `
          <article class="nqPriorityFinding">
            <div class="nqFindingIndex">0${index + 1}</div>
            <div class="nqFindingMain">
              <div class="nqFindingMeta"><span class="nqPriorityTag" data-priority="${escapeHtml(finding.priority || "medium")}">${escapeHtml(priorityText(finding.priority || "medium"))}</span><span>${escapeHtml(finding.category)}</span><span>${escapeHtml(finding.impact || "Medium")} impact</span></div>
              <h3>${escapeHtml(finding.title)}</h3>
              <p>${escapeHtml(finding.description || finding.categoryModel?.text || "")}</p>
            </div>
            <div class="nqFindingEvidence"><span>Supporting evidence</span><p>${escapeHtml(firstFailedEvidence(finding.categoryModel))}</p><a href="#category-${escapeHtml(finding.categoryModel?.id || "design")}">Review category <span aria-hidden="true">↘</span></a></div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}
function renderPriorityGroups(result) {
  const grouped = buildPriorityRecommendations(result).reduce((groups, item) => {
    groups[item.priority] = [...(groups[item.priority] || []), item];
    return groups;
  }, {});

  return ["high", "medium", "low"].map(priority => {
    const items = grouped[priority] || [];
    if (!items.length) return "";

    return `
      <details class="nqRecommendationGroup" ${priority === "high" ? "open" : ""}>
        <summary><span class="nqPriorityTag" data-priority="${priority}">${priorityText(priority)}</span><b>${items.length} ${items.length === 1 ? "recommendation" : "recommendations"}</b><i aria-hidden="true">+</i></summary>
        <div class="nqRecommendationList">
        ${items.map(item => `
          <article class="nqRecommendationCard">
            <span>${escapeHtml(item.category)}</span>
            <h3>${escapeHtml(item.text)}</h3>
            <div><b>Context</b><p>${escapeHtml(item.categoryModel?.text || "Category-level recommendation from this audit.")}</p></div>
            <div><b>Evidence</b><p>${escapeHtml(firstFailedEvidence(item.categoryModel))}</p></div>
          </article>
        `).join("")}
        </div>
      </details>
    `;
  }).join("");
}
function lowerMetricStatus(value, good, poor) {
    if (value == null) return { label: "Not measured", tone: "unavailable" };
    if (value <= good) return { label: "Good", tone: "good" };
    if (value <= poor) return { label: "Needs improvement", tone: "warning" };
    return { label: "Poor", tone: "critical" };
}
function lighthouseScoreStatus(value) {
  if (value == null) return { label: "Not measured", tone: "unavailable" };
  if (value >= 90) return { label: "Good", tone: "good" };
  if (value >= 50) return { label: "Needs improvement", tone: "warning" };
  return { label: "Poor", tone: "critical" };
}
function renderLabMetrics(lab, scannerStatusValue) {
  if (!lab?.metrics || !lab?.scores) {
    return `
      <section class="nqLabSection" id="real-page-performance" aria-labelledby="labTitle">
        <header class="nqReportSectionHeader"><div><p class="nqReportLabel"><span aria-hidden="true"></span>REAL PAGE PERFORMANCE</p><h2 id="labTitle">Browser metrics were not measured.</h2></div><span class="nqReportState" data-tone="unavailable"><i aria-hidden="true"></i>Not measured</span></header>
        <div class="nqLabUnavailable"><b>${escapeHtml(scannerStatusValue === "html-fallback-used" ? "A limited HTML fallback report is available." : "The HTML audit completed without rendered lab data.")}</b><p>Available category scores, checks, and recommendations remain visible. Missing Lighthouse values are not displayed as zero.</p></div>
      </section>
    `;
  }
  const performanceStatus = lab.scores.performance === null
    ? { label: "Not measured", tone: "unavailable" }
    : lighthouseScoreStatus(lab.scores.performance);
  const milliseconds = value => value == null ? "Not measured" : `${(value / 1000).toFixed(value >= 1000 ? 1 : 2)}s`;
  const metric = (label, explanation, value, display, good, poor) => {
    const status = lowerMetricStatus(value, good, poor);
    return `<article class="nqLabMetric" data-tone="${status.tone}"><div><span>${escapeHtml(label)}</span><b>${escapeHtml(display)}</b></div><p>${escapeHtml(explanation)}</p><em>${escapeHtml(status.label)}</em></article>`;
  };
  const issues = (lab.findings || []).slice(0, 3);
  const lighthouseScores = [
    ["Performance", lab.scores.performance],
    ["Accessibility", lab.scores.accessibility],
    ["Best practices", lab.scores.bestPractices],
    ["SEO", lab.scores.seo]
  ];

  return `
    <section class="nqLabSection" id="real-page-performance" aria-labelledby="labTitle">
      <header class="nqReportSectionHeader"><div><p class="nqReportLabel"><span aria-hidden="true"></span>REAL PAGE PERFORMANCE</p><h2 id="labTitle">What the rendered page revealed.</h2></div><span class="nqReportState" data-tone="${performanceStatus.tone}"><i aria-hidden="true"></i>${escapeHtml(performanceStatus.label)}</span></header>
      <p class="nqLabContext">Measured in a real browser under consistent lab conditions. TBT is a responsiveness proxy; real-user INP is not measured.</p>
      <div class="nqLabMetricGrid">
        ${metric("Main content", "How quickly the largest visible content appears (LCP).", lab.metrics.lcpMs, milliseconds(lab.metrics.lcpMs), 2500, 4000)}
        ${metric("Visual stability", "How much the layout moves unexpectedly while loading (CLS).", lab.metrics.cls, lab.metrics.cls == null ? "Not measured" : lab.metrics.cls.toFixed(3), 0.1, 0.25)}
        ${metric("First content", "How quickly the first text or image becomes visible (FCP).", lab.metrics.fcpMs, milliseconds(lab.metrics.fcpMs), 1800, 3000)}
        ${metric("Visual loading", "How quickly the visible page fills in (Speed Index).", lab.metrics.speedIndexMs, milliseconds(lab.metrics.speedIndexMs), 3400, 5800)}
        ${metric("Responsiveness proxy", "Main-thread blocking during load (TBT), used as a lab clue for responsiveness.", lab.metrics.tbtMs, lab.metrics.tbtMs == null ? "Not measured" : `${Math.round(lab.metrics.tbtMs)}ms`, 200, 600)}
      </div>
      <div class="nqLighthouseScores" aria-label="Lighthouse category scores">${lighthouseScores.map(([label, value]) => { const state = lighthouseScoreStatus(value); return `<div data-tone="${state.tone}"><span>${escapeHtml(label)}</span><b>${value == null ? "Not measured" : `${value}/100`}</b><em>${escapeHtml(state.label)}</em></div>`; }).join("")}</div>
      ${issues.length ? `<div class="nqLabFindings"><h3>Confirmed Lighthouse findings</h3>${issues.map(item => `<article><b>${escapeHtml(item.title)}</b>${item.displayValue ? `<span>${escapeHtml(item.displayValue)}</span>` : ""}<p>${escapeHtml(item.action)}</p></article>`).join("")}</div>` : ""}
    </section>
  `;
}
function renderTechnicalDetails(result) {
  const rendered = result.signals?.rendered;
  const diagnostics = rendered ? [
    ["Rendered status", rendered.status],
    ["Console errors", rendered.consoleErrorCount],
    ["Page errors", rendered.pageErrorCount],
    ["Failed requests", rendered.failedRequestCount],
    ["Blocked unsafe requests", rendered.blockedUnsafeRequestCount],
    ["Rendered DOM bytes", rendered.renderedDomBytes]
  ].filter(([, value]) => value !== undefined && value !== null) : [];
  const checkedAt = result.checkedAt && !Number.isNaN(new Date(result.checkedAt).getTime())
    ? new Date(result.checkedAt).toLocaleString()
    : "Not available";

  return `
    <section class="nqTechnicalSection" aria-labelledby="technicalTitle">
      <details class="nqTechnicalDetails">
        <summary><span><small>DEEPER CONTEXT</small><b id="technicalTitle">Technical details</b></span><span>Scanner, diagnostics, and notices</span><i aria-hidden="true">+</i></summary>
        <div class="nqTechnicalBody">
          <div class="nqTechnicalMeta"><span>Scanner mode <b>${escapeHtml(scannerLabel(result.scanner?.mode))}</b></span><span>Checked at <b>${escapeHtml(checkedAt)}</b></span><span>Audit status ${scannerStatus(result.scanner?.status)}</span></div>
          <div class="nqTechnicalAdapters"><h3>Scanner adapters</h3><div>${renderAdapters(result.scanner?.adapters || []) || "<span>Not available</span>"}</div></div>
          ${diagnostics.length ? `<div class="nqRenderedDiagnostics"><h3>Rendered diagnostics</h3><dl>${diagnostics.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></div>` : `<div class="nqRenderedDiagnostics"><h3>Rendered diagnostics</h3><p>Not measured for this audit.</p></div>`}
          ${renderWarnings(result.warnings)}
        </div>
      </details>
    </section>
  `;
}
function resetAuditForm() {
  cancelActiveAuditRun();
  analysisExperience.reset();
  report.hidden = true;
  report.innerHTML = "";
  document.body.classList.remove("noqori-report-view");
  document.getElementById("landing").hidden = false;
  errorBox.hidden = true;
  input.removeAttribute("aria-invalid");
  input.value = "";
  if (history.replaceState) {
    history.replaceState(null, "", window.location.pathname);
  }
  window.scrollTo({ top: 0, behavior: "auto" });
  input.focus();
}
function render(result) {
  const safeDomain = escapeHtml(result.domain);
  const safeUrl = escapeHtml(result.normalizedUrl || result.domain);
  const overallTone = statusTone(scoreStatusLabel(result.overall), result.overall);
  report.innerHTML = `
    <div class="nqPrintHeader"><img src="/assets/noqori/noqori-mark-ink.png" alt="" /><div><b>NOQORI AUDIT REPORT</b><span>${safeDomain}</span><small>${safeUrl}</small></div></div>
    <header class="nqReportHeader">
      <a class="nqReportBrand" href="/" aria-label="NOQORI home"><img src="/assets/noqori/noqori-mark-ink.png" alt="" /><span>NOQORI / AUDIT REPORT</span></a>
      <div class="nqReportIdentity"><p class="nqReportKicker">Audit report</p><h1>${safeDomain}</h1><p>${safeUrl}</p></div>
      <div class="nqReportActions"><button type="button" data-report-action="print">Print report <span aria-hidden="true">↗</span></button><button type="button" data-report-action="reset">Analyze another <span aria-hidden="true">↺</span></button></div>
    </header>

    <section class="nqExecutiveSummary" aria-labelledby="summaryTitle">
      <div class="nqOverallColumn">
        <p class="nqReportLabel"><span aria-hidden="true"></span>EXECUTIVE SUMMARY</p>
        <h2 id="summaryTitle">How did this site do?</h2>
        <div class="nqOverallScore" role="img" aria-label="Overall score ${result.overall} out of 100, ${escapeHtml(scoreStatusLabel(result.overall))}" data-tone="${overallTone}"><span>Overall score</span><strong>${result.overall}</strong><small>/100</small></div>
        <div class="nqOverallCopy"><span class="nqReportState" data-tone="${overallTone}"><i aria-hidden="true"></i>${escapeHtml(scoreStatusLabel(result.overall))}</span><p>${escapeHtml(overallSummary(result.overall))}</p></div>
        <div class="nqAuditContext">${scannerStatus(result.scanner?.status)}<span>${escapeHtml(scannerLabel(result.scanner?.mode))}</span></div>
      </div>
      <div class="nqCategoryOverview">
        <div class="nqOverviewHeading"><span>CATEGORY OVERVIEW</span><p>All eight categories contribute equally to the overall score.</p></div>
        <div class="nqOverviewList">${result.cats.map(category => `<a href="#category-${escapeHtml(category.id)}"><span><b>${escapeHtml(category.name)}</b><small>${escapeHtml(category.status)}</small></span><strong>${category.score}</strong><i data-tone="${statusTone(category.status, category.score)}" aria-hidden="true"></i></a>`).join("")}</div>
      </div>
    </section>

    ${renderPriorityFindings(result)}
    ${renderLabMetrics(result.signals?.lab, result.scanner?.status)}

    <section class="nqRecommendations" aria-labelledby="recommendationsTitle">
      <header class="nqReportSectionHeader"><div><p class="nqReportLabel"><span aria-hidden="true"></span>ACTION PLAN</p><h2 id="recommendationsTitle">Recommendations by priority</h2></div><p>Open a priority group to review its actions and the audit context behind them.</p></header>
      <div>${renderPriorityGroups(result)}</div>
    </section>

    <section class="nqCategoriesSection" aria-labelledby="categoriesTitle">
      <header class="nqReportSectionHeader"><div><p class="nqReportLabel"><span aria-hidden="true"></span>EVIDENCE BY CATEGORY</p><h2 id="categoriesTitle">Go deeper when you need to.</h2></div><p>Review failed checks first. Passed checks remain available without competing for attention.</p></header>
      ${renderCategoryNavigation(result)}
      <div class="nqCategoryList">${result.cats.map(renderCategory).join("")}</div>
    </section>

    ${renderTechnicalDetails(result)}

    <section class="nqReportEnd" aria-labelledby="reportEndTitle"><div><p class="nqReportLabel"><span aria-hidden="true"></span>NEXT AUDIT</p><h2 id="reportEndTitle">Ready to analyze another website?</h2><p>Return to the existing audit flow and start with a new public URL.</p></div><button type="button" data-report-action="reset">Analyze another website <span aria-hidden="true">↗</span></button></section>
  `;
  document.getElementById("landing").hidden = true;
  document.body.classList.add("noqori-report-view");
  report.hidden = false;
  window.scrollTo({ top: 0, behavior: "auto" });
}
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  input.setAttribute("aria-invalid", "true");
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  cancelActiveAuditRun();
  errorBox.hidden = true;
  input.removeAttribute("aria-invalid");
  loading.hidden = true;
  const runButton = document.getElementById("runBtn");
  runButton.disabled = false;
  const clientError = validateClientUrl(input.value);

  if (clientError) {
    showError(clientError);
    return;
  }

  loading.hidden = true;
  loadingText.textContent = "Starting your audit…";
  runButton.disabled = true;
  const run = { controller: new AbortController(), job: null };
  activeAuditRun = run;
  analysisExperience.show(input.value);

  try {
    const job = await requestAudit(input.value, { signal: run.controller.signal });
    assertActiveRun(run);
    run.job = job;
    loadingText.textContent = "Your audit is queued…";
    analysisExperience.setState("queued");
    const audit = await pollAuditJob(job.statusUrl, {
      signal: run.controller.signal,
      isCurrent: () => activeAuditRun === run,
      onStatus: status => {
        if (activeAuditRun === run) analysisExperience.setState(status);
      }
    });
    assertActiveRun(run);
    const result = toReportViewModel(audit);
    loading.hidden = true;
    runButton.disabled = false;
    await analysisExperience.complete();
    assertActiveRun(run);
    render(result);
    input.removeAttribute("aria-invalid");
  } catch (error) {
    if (isAbortError(error) || activeAuditRun !== run) return;
    if (error.code === "AUTHENTICATION_REQUIRED") return;
    loading.hidden = true;
    runButton.disabled = false;
    analysisExperience.fail(error.message || "Could not run the audit. Please try again.", { code: error.code });
  } finally {
    if (activeAuditRun === run) activeAuditRun = null;
  }
});
window.addEventListener("beforeunload", cancelActiveAuditRun);
report.addEventListener("click", event => {
  const action = event.target.closest("[data-report-action]")?.dataset.reportAction;
  if (action === "print") window.print();
  if (action === "reset") resetAuditForm();
});
window.addEventListener("beforeprint", () => {
  document.querySelectorAll("#report details").forEach(details => {
    details.dataset.wasOpen = details.open ? "true" : "false";
    details.open = true;
  });
});
window.addEventListener("afterprint", () => {
  document.querySelectorAll("#report details").forEach(details => {
    details.open = details.dataset.wasOpen === "true";
    delete details.dataset.wasOpen;
  });
});
void restoreSession();
