// Turns `npm audit --json` output plus the package-lock.json it was run against
// into actionable findings: one per actually vulnerable package (not the
// packages that merely depend on it), with the lowest fixed version and how to
// get there given the version ranges in the lockfile.
//
// Usage: node npm-audit-findings.mjs <dir> <audit.json> <findings.json> <report.md>
//
// findings.json: { dir, error, findings: [...], unfixable: [...] }. The scan
// fails when `error` is set or `findings` is non-empty; `unfixable` lists
// high/critical packages with no fix at all (reported, not failing).
// report.md: the Markdown section for the PR comment.
//
// Uses the semver package bundled with npm itself, so there is nothing to
// install and range semantics match what npm does.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const [dir, auditPath, findingsPath, reportPath] = process.argv.slice(2);
if (!dir || !auditPath || !findingsPath || !reportPath) {
  console.error("usage: npm-audit-findings.mjs <dir> <audit.json> <findings.json> <report.md>");
  process.exit(2);
}

const npmRoot = process.env.NPM_GLOBAL_ROOT || execSync("npm root -g", { encoding: "utf8" }).trim();
const semver = createRequire(path.join(npmRoot, "npm", "package.json"))("semver");

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
const isHighOrCritical = (s) => SEVERITY_RANK[s] >= SEVERITY_RANK.high;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function write(result, markdown) {
  writeFileSync(findingsPath, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(reportPath, markdown);
}

// Escape for a Markdown table cell (a bare | ends the cell, even in code spans).
const cell = (s) => String(s).replace(/\|/g, "\\|");
const code = (s) => "`" + cell(s) + "`";

const audit = readJson(auditPath);
if (!audit || audit.error || typeof audit.vulnerabilities !== "object") {
  const reason = audit?.error?.summary || audit?.error?.code || "npm audit produced no usable output";
  write(
    { dir, error: reason, findings: [], unfixable: [] },
    `**${code(dir)}**\n\n> [!WARNING]\n> npm audit could not run here: ${cell(reason)}\n\n`
  );
  process.exit(0);
}

// lockfileVersion 2/3 carry a flat `packages` map keyed by install path, which
// is what lets us see who depends on a vulnerable copy and with what range.
// lockfileVersion 1 does not; we then fall back to what npm audit reports.
const lockPackages = readJson(path.join(dir, "package-lock.json"))?.packages ?? null;

const nameOf = (p) => (p === "" ? "(root)" : p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length));
const parentOf = (p) => {
  const i = p.lastIndexOf("node_modules/");
  return i <= 0 ? "" : p.slice(0, i).replace(/\/$/, "");
};

// Node's resolution: the nearest node_modules/<name> walking up from `from`.
function resolve(from, name) {
  let base = from;
  for (;;) {
    const candidate = (base ? base + "/" : "") + "node_modules/" + name;
    if (lockPackages[candidate]) return candidate;
    if (base === "") return null;
    base = parentOf(base);
  }
}

// Every lockfile entry that resolves `name` to the copy at `nodePath`, with the
// range it asks for.
const dependentsCache = new Map();
function dependentsOf(nodePath) {
  if (!lockPackages) return [];
  if (dependentsCache.has(nodePath)) return dependentsCache.get(nodePath);
  const name = nameOf(nodePath);
  const result = [];
  for (const [from, entry] of Object.entries(lockPackages)) {
    const ranges = {
      ...(entry.peerDependencies || {}),
      ...(entry.optionalDependencies || {}),
      ...(from === "" ? entry.devDependencies || {} : {}),
      ...(entry.dependencies || {}),
    };
    if (name in ranges && resolve(from, name) === nodePath) {
      result.push({ path: from, name: nameOf(from), range: ranges[name] });
    }
  }
  dependentsCache.set(nodePath, result);
  return result;
}

// The packages in the project's own package.json that pull `nodePath` in.
function introducedBy(nodePath, seen = new Set()) {
  if (seen.has(nodePath)) return new Set();
  seen.add(nodePath);
  const roots = new Set();
  for (const dep of dependentsOf(nodePath)) {
    if (dep.path === "") roots.add(nameOf(nodePath));
    else for (const r of introducedBy(dep.path, seen)) roots.add(r);
  }
  return roots;
}

// The version that ends this advisory for `version`: the exclusive upper bound
// of the comparator set it falls in. An inclusive "<=X" bound is how advisories
// say "every release up to the latest", i.e. no fixed version is known.
function advisoryFix(range, version) {
  let parsed;
  try {
    parsed = new semver.Range(range);
  } catch {
    return null;
  }
  for (const set of parsed.set) {
    if (!set.every((c) => c.test(version))) continue;
    const upper = set.find((c) => c.operator === "<");
    return upper ? upper.semver.version : null;
  }
  return null;
}

// Lowest version clearing every advisory, or null if any has no known fix.
function fixedVersion(advisories, version) {
  const fixes = advisories.map((a) => advisoryFix(a.range, version));
  if (fixes.length === 0 || fixes.includes(null)) {
    // An advisory without a fix may still be cleared by another's fix.
    const known = fixes.filter(Boolean);
    if (known.length === 0) return null;
    const candidate = known.sort(semver.compare).at(-1);
    return advisories.some((a) => semver.satisfies(candidate, a.range)) ? null : candidate;
  }
  return fixes.sort(semver.compare).at(-1);
}

function rangeAllows(range, version) {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return true; // git/url/alias specs: unknown, don't claim a block
  }
}

function lockVersion(p) {
  return lockPackages?.[p]?.version ?? null;
}

// Which advisories affect the given versions, via the same bulk endpoint
// `npm audit` uses. Returns null if it can't be reached, so callers fall back to
// what the audit output alone says.
async function advisoriesFor(versionsByName) {
  if (Object.keys(versionsByName).length === 0) return {};
  try {
    let registry = execSync("npm config get registry", { cwd: dir, encoding: "utf8" }).trim() || "https://registry.npmjs.org/";
    if (!registry.endsWith("/")) registry += "/";
    const res = await fetch(registry + "-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(versionsByName),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const vulns = audit.vulnerabilities;
const entries = [];

for (const [name, vuln] of Object.entries(vulns)) {
  // Only packages with advisories of their own. npm also lists everything that
  // depends on them, inheriting their severity; those are covered by the
  // "Introduced by" column instead of repeating the same advisories.
  const own = [];
  const seenAdvisory = new Set();
  for (const v of vuln.via || []) {
    if (typeof v !== "object" || seenAdvisory.has(v.url || v.source)) continue;
    seenAdvisory.add(v.url || v.source);
    own.push(v);
  }
  if (own.length === 0) continue;
  const severity = own.map((a) => a.severity).sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0];
  if (!isHighOrCritical(severity)) continue;

  const nodes = (vuln.nodes || []).filter((n) => lockVersion(n));
  const installed = [...new Set(nodes.map(lockVersion))].sort(semver.compare);
  const lowest = installed[0] ?? null;

  // When the advisories only give inclusive bounds (often written before the
  // fix shipped), fall back to the version of this package npm says fixes it,
  // provided it really is outside every advisory. It may not be the lowest
  // fixed release (npm targets the latest), but it is a correct one.
  let fixedIn = lowest ? fixedVersion(own, lowest) : null;
  const npmTarget = vuln.fixAvailable;
  if (!fixedIn && lowest && typeof npmTarget === "object" && npmTarget.name === name &&
      semver.valid(npmTarget.version) && semver.gt(npmTarget.version, lowest) &&
      !own.some((a) => rangeAllows(a.range, npmTarget.version))) {
    fixedIn = npmTarget.version;
  }

  const advisories = own
    .slice()
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || String(a.url).localeCompare(String(b.url)))
    .map((a) => ({ id: String(a.url || a.source).split("/").pop(), url: a.url || null, severity: a.severity, title: a.title || "" }));

  entries.push({ name, vuln, own, severity, nodes, installed, lowest, fixedIn, advisories });
}

// The audit only lists advisories affecting the installed version, so a fix
// version can fall inside a different advisory that starts later (e.g. axios
// 0.33.0 clears everything affecting 0.21.0 but is hit by ">=0.28.0 <0.34.0").
// Check each candidate and move past any such advisory, a few rounds at most.
for (let round = 0; round < 5; round++) {
  const pending = entries.filter((e) => e.fixedIn && !e.fixChecked);
  if (pending.length === 0) break;
  const result = await advisoriesFor(Object.fromEntries(pending.map((e) => [e.name, [e.fixedIn]])));
  if (!result) break; // registry unreachable: keep the audit-based answer
  for (const e of pending) {
    const hits = (result[e.name] || []).filter((a) => rangeAllows(a.vulnerable_versions, e.fixedIn));
    if (hits.length === 0) {
      e.fixChecked = true;
      continue;
    }
    const next = fixedVersion(hits.map((a) => ({ range: a.vulnerable_versions })), e.fixedIn);
    e.fixedIn = next && semver.gt(next, e.fixedIn) ? next : null;
  }
}

const findings = [];
const unfixable = [];

for (const { name, vuln, severity, nodes, installed, lowest, fixedIn, advisories } of entries) {
  const introduced = new Set();
  for (const n of nodes) for (const r of introducedBy(n)) introduced.add(r);
  const direct = nodes.some((n) => dependentsOf(n).some((d) => d.path === ""));
  const rootRange = (dep) => {
    const root = lockPackages?.[""] || {};
    return (root.dependencies || {})[dep] ?? (root.optionalDependencies || {})[dep] ?? (root.devDependencies || {})[dep] ?? null;
  };

  let action;
  if (fixedIn) {
    // Who would stop npm from installing the fixed version?
    const blockers = [];
    for (const n of nodes) {
      if (!semver.lt(lockVersion(n), fixedIn)) continue;
      for (const d of dependentsOf(n)) {
        if (!rangeAllows(d.range, fixedIn) && !blockers.some((b) => b.path === d.path)) blockers.push(d);
      }
    }
    const rootBlock = blockers.find((b) => b.path === "");
    const others = blockers.filter((b) => b.path !== "");
    // fixedIn is only set when lowest is. Pre-1.0, a minor bump is a major one.
    const breaking = semver.major(fixedIn) !== semver.major(lowest) ||
      (semver.major(fixedIn) === 0 && semver.minor(fixedIn) !== semver.minor(lowest));
    if (!lockPackages && vuln.fixAvailable === true) action = { type: "update" };
    else if (blockers.length === 0) action = { type: "update" };
    else if (others.length === 0) action = { type: "direct", name, range: "^" + fixedIn, from: rootBlock.range, breaking };
    else {
      // A plain override replaces every copy of the package. If other copies are
      // on a different major (e.g. semver 5 for one dependency, 7 for another),
      // scope it to the packages pinning the vulnerable copy instead.
      const allVersions = Object.entries(lockPackages)
        .filter(([p]) => p.endsWith("node_modules/" + name))
        .map(([, e]) => e.version)
        .filter((v) => semver.valid(v));
      const scoped = allVersions.some((v) => semver.major(v) !== semver.major(fixedIn));
      action = { type: "override", range: "^" + fixedIn, scoped, blockers: others.map((b) => ({ name: b.name, range: b.range })), alsoDirect: rootBlock ? rootBlock.range : null };
    }
  } else if (vuln.fixAvailable && typeof vuln.fixAvailable === "object") {
    // No fixed release of the package itself: npm's suggestion of upgrading the
    // package that pulls it in is the only route, unless that is a downgrade.
    const target = vuln.fixAvailable;
    const current = lockVersion("node_modules/" + target.name);
    const declared = rootRange(target.name);
    if (current && semver.valid(target.version) && semver.lt(target.version, current)) {
      action = { type: "none", note: `npm only offers downgrading ${target.name} to ${target.version}` };
    } else if (declared && !rangeAllows(declared, target.version)) {
      // `npm audit fix` won't move a package.json range on its own (it asks
      // for --force even for a minor bump), so say which line to change.
      action = { type: "direct", name: target.name, range: "^" + target.version, from: declared, breaking: !!target.isSemVerMajor, parentOf: name };
    } else {
      action = { type: "parent", name: target.name, version: target.version, breaking: !!target.isSemVerMajor };
    }
  } else if (vuln.fixAvailable === true) {
    action = { type: "update" };
  } else {
    action = { type: "none" };
  }

  const entry = { name, severity, installed, introducedBy: direct ? ["direct"] : [...introduced].sort(), advisories, fixedIn, action };
  if (action.type === "none") unfixable.push(entry);
  else findings.push(entry);
}

const bySeverityThenName = (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.name.localeCompare(b.name);
findings.sort(bySeverityThenName);
unfixable.sort(bySeverityThenName);

function howToFix(f) {
  const a = f.action;
  const prefix = dir === "." ? "" : ` --prefix ${dir}`;
  switch (a.type) {
    case "update":
      return `${code(`npm audit fix${prefix}`)}`;
    case "direct":
      return `Change ${code(a.name)} from ${code(a.from)} to ${code(a.range)} in package.json` + (a.breaking ? " _(major version: may be breaking)_" : "") +
        (a.parentOf ? " _(no fixed release of this package; that version no longer pulls in a vulnerable one)_" : "");
    case "override": {
      const pinned = a.blockers.slice(0, 3).map((b) => `${code(b.name)} (${code(b.range)})`).join(", ") + (a.blockers.length > 3 ? ` +${a.blockers.length - 3} more` : "");
      // Scoped form: { "<pinning package>": { "<name>": "<range>" } }, one per pinning package.
      const entry = code(a.scoped
        ? `"overrides": { ${a.blockers.map((b) => `"${b.name}": { "${f.name}": "${a.range}" }`).join(", ")} }`
        : `"overrides": { "${f.name}": "${a.range}" }`);
      return `Add ${entry} to package.json _(pinned by ${pinned}; test, as it is outside their range)_` + (a.alsoDirect ? `, and change ${code(f.name)} from ${code(a.alsoDirect)} to ${code(a.range)}` : "");
    }
    case "parent":
      return `Upgrade ${code(a.name)} to ${code(a.version)}: ${code(`npm audit fix${a.breaking ? " --force" : ""}${prefix}`)}` + (a.breaking ? " _(breaking)_" : "") + " _(no fixed release of this package)_";
    default:
      return "-";
  }
}

function advisoryLinks(advisories) {
  const shown = advisories.slice(0, 3).map((a) => (a.url ? `[${cell(a.id)}](${a.url})` : cell(a.id)));
  return shown.join(", ") + (advisories.length > 3 ? ` _+${advisories.length - 3} more_` : "");
}

let md = "";
if (findings.length || unfixable.length) {
  md += `**${code(dir)}**\n\n`;
}
if (findings.length) {
  md += "| Package | Severity | Installed | Introduced by | Fixed in | How to fix | Advisories |\n";
  md += "|---------|----------|-----------|---------------|----------|------------|------------|\n";
  for (const f of findings) {
    const by = f.introducedBy.length ? f.introducedBy.slice(0, 3).map(code).join(", ") + (f.introducedBy.length > 3 ? ` +${f.introducedBy.length - 3} more` : "") : "-";
    md += `| ${code(f.name)} | ${f.severity.toUpperCase()} | ${code(f.installed.join(", ") || "?")} | ${by} | ${f.fixedIn ? code(f.fixedIn) : "-"} | ${howToFix(f)} | ${advisoryLinks(f.advisories)} |\n`;
  }
  md += "\n";
}
if (unfixable.length) {
  md += `_No fix available yet (not failing the scan): ${unfixable.map((u) => `${code(u.name)} (${u.severity}${u.action.note ? `; ${cell(u.action.note)}` : ""})`).join(", ")}._\n\n`;
}

write({ dir, error: null, findings, unfixable }, md);
