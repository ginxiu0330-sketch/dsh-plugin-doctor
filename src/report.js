/**
 * Read-only collection of a DSH profile's health facts.
 *
 * Everything here is a pure read against host services: no profile file is
 * written, no package is installed, no patch is applied. The result is one
 * plain JSON object that both the tool output schema and the markdown renderer
 * consume, so the shape is the contract between them.
 */

/** Source priority for skills; the lowest index wins a name collision. */
const SKILL_SOURCE_ORDER = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'runtime', 'bundled'];

/** Statuses a plugin row can carry, most severe first. */
export const PLUGIN_STATUSES = ['error', 'incompatible', 'update', 'local', 'ok', 'unknown'];

const safeMessage = (error) => (error && typeof error === 'object' && typeof error.message === 'string')
  ? error.message
  : String(error);

/**
 * Classify where a profile package came from, from the saved spec.
 * @param {string | undefined} source - the profile's dependency spec.
 * @returns {string} a short channel name.
 */
export function channelOf(source) {
  if (!source) return 'unknown';
  const spec = String(source);
  if (spec.startsWith('file:') || spec.startsWith('link:')) return 'file';
  if (spec.startsWith('git+') || spec.startsWith('git:') || spec.includes('://') && spec.includes('.git')) return 'git';
  if (/^https?:/.test(spec)) return 'tarball';
  return 'registry';
}

/** The running DSH version, or a reason it is unknown. */
async function readRuntimeVersion() {
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot');
    if (typeof boot.getDshRuntimeVersion === 'function') {
      const version = boot.getDshRuntimeVersion();
      if (version) return String(version);
    }
  } catch {
    // The host package is not importable in this process; fall back below.
  }
  return undefined;
}

/**
 * Ask the registry for versions newer than the installed one.
 * @returns {Promise<{kind: string, latest?: string, version?: object, reason?: string, omitted?: number}>}
 */
async function queryLatestVersion(pluginManager, name, timeoutMs) {
  if (typeof pluginManager?.listVersions !== 'function') return { kind: 'unsupported', reason: 'pluginManager.listVersions is unavailable' };
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const list = await pluginManager.listVersions(name, undefined, signal);
    if (list?.status === 'listed') {
      const newest = Array.isArray(list.versions) ? list.versions[0] : undefined;
      return { kind: 'listed', latest: newest?.version, version: newest, omitted: list.omitted ?? 0 };
    }
    if (list?.status === 'refused') {
      return { kind: list.problem ?? 'unknown', reason: list.reason };
    }
    return { kind: 'unknown', reason: 'listVersions returned an unrecognized payload' };
  } catch (error) {
    const message = safeMessage(error);
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { kind: timedOut ? 'timeout' : 'error', reason: timedOut ? `no registry answer within ${timeoutMs} ms` : message };
  }
}

/** Decide the row status for one profile package. */
function classify(bundle, lookup) {
  if (bundle.error) {
    const diagnostic = bundle.error.diagnostic ? `: ${bundle.error.diagnostic}` : '';
    return { status: bundle.error.code === 'incompatible-version' ? 'incompatible' : 'error', note: `${bundle.error.code}${diagnostic}` };
  }
  if (bundle.readOnlyReason) return { status: 'local', note: bundle.readOnlyReason };
  if (bundle.update === 'registry') {
    if (!lookup) return { status: 'unknown', note: 'update check disabled' };
    if (lookup.kind === 'listed') {
      return lookup.latest
        ? { status: 'update', latest: lookup.latest }
        : { status: 'ok', note: 'up to date' };
    }
    if (lookup.kind === 'not-updatable') return { status: 'local', note: 'not a registry dependency' };
    if (lookup.kind === 'not-found') return { status: 'unknown', note: 'not found on the registry' };
    if (lookup.kind === 'network' || lookup.kind === 'timeout') return { status: 'unknown', note: `registry unreachable: ${lookup.reason ?? lookup.kind}` };
    if (lookup.kind === 'unsupported') return { status: 'unknown', note: lookup.reason };
    return { status: 'unknown', note: lookup.reason ?? lookup.kind };
  }
  if (bundle.update === 'git') return { status: 'local', note: 'git-pinned; update by commit' };
  if (bundle.official) return { status: 'ok', note: 'shipped with DSH' };
  return { status: 'local', note: bundle.source ? `${channelOf(bundle.source)} spec` : 'not updatable' };
}

/**
 * Build the plugin rows for every package the profile actually carries.
 * @returns {Promise<{plugins: object[], bundles: object[]}>}
 */
async function collectPlugins(pluginManager, checkUpdates, timeoutMs) {
  if (typeof pluginManager?.listBundles !== 'function') {
    return { plugins: [], bundles: [], unavailable: 'pluginManager.listBundles is unavailable' };
  }
  const all = await pluginManager.listBundles();
  const carried = all.filter((bundle) => bundle.installed || bundle.availability === 'profile');

  const lookups = await Promise.all(carried.map((bundle) => (
    checkUpdates && bundle.update === 'registry' && !bundle.error
      ? queryLatestVersion(pluginManager, bundle.name, timeoutMs)
      : Promise.resolve(undefined)
  )));

  const plugins = carried.map((bundle, index) => {
    const lookup = lookups[index];
    const verdict = classify(bundle, lookup);
    const row = {
      name: bundle.name,
      installed: bundle.version ?? 'unknown',
      status: verdict.status,
      enabled: bundle.enabled === true,
      official: bundle.official === true,
      channel: bundle.update === 'registry' ? 'registry' : bundle.update === 'git' ? 'git' : channelOf(bundle.source),
    };
    if (verdict.latest) row.latest = verdict.latest;
    if (verdict.note) row.note = verdict.note;
    if (lookup?.version?.deprecated) row.deprecated = String(lookup.version.deprecated);
    if (lookup?.version && lookup.version.bundle === false) row.replacesBundle = false;
    if (lookup?.version?.incompatible) {
      row.targetIncompatible = Object.entries(lookup.version.incompatible.requirements ?? {})
        .map(([requirement, range]) => `${requirement}: needs ${range}`);
    }
    return row;
  });

  return { plugins, bundles: carried };
}

/** Rows the running DSH version rejects, from both the installed and the candidate version. */
function collectCompatibility(bundles, plugins) {
  const found = [];
  for (const bundle of bundles) {
    const incompatible = bundle.error?.incompatible;
    if (!Array.isArray(incompatible)) continue;
    for (const entry of incompatible) {
      found.push({
        name: entry.name ?? bundle.name,
        installed: entry.version ?? bundle.version ?? 'unknown',
        runtime: entry.runtimeVersion ?? 'unknown',
        requirements: Object.entries(entry.requirements ?? {}).map(([requirement, range]) => `${requirement}: ${range}`),
        scope: 'installed',
      });
    }
  }
  for (const plugin of plugins) {
    if (!plugin.targetIncompatible?.length) continue;
    found.push({
      name: plugin.name,
      installed: plugin.installed,
      runtime: 'unknown',
      requirements: plugin.targetIncompatible,
      scope: `candidate ${plugin.latest ?? '?'}`,
    });
  }
  return found;
}

/** Patch-level facts: how much each bundle's patch touches, and what it overrides. */
function collectPatches(bundles) {
  return bundles.map((bundle) => {
    const rows = Array.isArray(bundle.rows) ? bundle.rows.length : 0;
    // The host reports an override as an id the bundle patches without inserting it: an id
    // some other bundle owns. Keep the ids; a count alone tells nobody what to fix.
    const overrideIds = Array.isArray(bundle.overrides) ? bundle.overrides : [];
    const problems = [];
    if (bundle.error && (bundle.error.code === 'unexpected-package' || bundle.error.code === 'not-bundle')) {
      problems.push(`patch unusable: ${bundle.error.code}`);
    }
    if (!Array.isArray(bundle.rows) && !bundle.error) problems.push('patch rows could not be read');
    if (bundle.availability === 'missing') problems.push('package files are missing');
    return {
      bundle: bundle.name,
      rows,
      overrides: overrideIds.length,
      overrideIds,
      enabled: bundle.enabled === true,
      problems,
    };
  }).filter((row) => row.rows > 0 || row.overrideIds.length > 0 || row.problems.length > 0);
}

/** Skill rows, flagging names that another source shadows. */
async function collectSkills(skills) {
  if (typeof skills?.list !== 'function') return { rows: [], unavailable: 'skills.list is unavailable' };
  const listed = await skills.list({});
  const order = (source) => {
    const index = SKILL_SOURCE_ORDER.indexOf(String(source));
    return index === -1 ? SKILL_SOURCE_ORDER.length : index;
  };
  const groups = new Map();
  for (const skill of listed) {
    if (!skill?.name) continue;
    const bucket = groups.get(skill.name) ?? [];
    bucket.push(skill);
    groups.set(skill.name, bucket);
  }
  const rows = [];
  for (const [name, bucket] of groups) {
    const sorted = [...bucket].sort((a, b) => order(a.source) - order(b.source));
    sorted.forEach((skill, index) => {
      const row = { name, source: String(skill.source ?? 'unknown'), invocation: String(skill.invocation ?? 'unknown') };
      if (skill.path) row.path = String(skill.path);
      if (index > 0) {
        row.shadowed = true;
        row.shadowedBy = String(sorted[0].source ?? 'unknown');
      }
      rows.push(row);
    });
  }
  return { rows };
}

/**
 * Collect the whole report.
 * @param {object} ctx - the cordis context carrying pluginManager and skills.
 * @param {{checkUpdates?: boolean, checkSkills?: boolean, timeoutMs?: number}} [options]
 */
export async function collectReport(ctx, options = {}) {
  const checkUpdates = options.checkUpdates !== false;
  const checkSkills = options.checkSkills !== false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Math.round(options.timeoutMs)) : 20000;

  const pluginManager = ctx.pluginManager;
  const runtimeVersion = await readRuntimeVersion();
  const { plugins, bundles, unavailable } = await collectPlugins(pluginManager, checkUpdates, timeoutMs);
  const compatibility = collectCompatibility(bundles, plugins);
  const patches = collectPatches(bundles);
  const skills = checkSkills ? await collectSkills(ctx.skills) : { rows: [] };

  const count = (status) => plugins.filter((plugin) => plugin.status === status).length;
  const summary = {
    plugins: plugins.length,
    updates: count('update'),
    incompatible: count('incompatible'),
    errors: count('error'),
    local: count('local'),
    unknown: count('unknown'),
    skills: skills.rows.length,
    shadowedSkills: skills.rows.filter((row) => row.shadowed).length,
    patchOverrides: patches.reduce((total, row) => total + row.overrides, 0),
  };

  const report = {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    summary,
  };
  if (runtimeVersion) report.runtime = runtimeVersion;
  if (unavailable) report.pluginManagerError = unavailable;
  report.plugins = plugins;
  report.compatibility = compatibility;
  report.patches = patches;
  report.skills = skills.rows;
  if (skills.unavailable) report.skillsError = skills.unavailable;
  return report;
}
