/**
 * Markdown projection of a doctor report.
 *
 * The tool's canonical value stays JSON; this module only turns it into the
 * blocks the model reads. Nothing here inspects the host.
 */

const STATUS_LABEL = {
  update: 'update',
  incompatible: 'INCOMPATIBLE',
  error: 'error',
  local: 'local',
  ok: 'ok',
  unknown: 'unknown',
};

/** Escape a cell so a stray pipe cannot break the table. */
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const table = (headers, rows) => {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
};

const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso ?? '') : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

/**
 * Render one report.
 * @param {object} report - the canonical value produced by collectReport.
 * @returns {string} markdown.
 */
export function renderReport(report) {
  const lines = [];
  const summary = report.summary ?? {};

  lines.push(`# DSH plugin doctor — ${stamp(report.checkedAt)}`);
  lines.push('');
  const headline = [
    report.runtime ? `runtime ${report.runtime}` : 'runtime unknown',
    `${summary.plugins ?? 0} packages`,
    `${summary.updates ?? 0} upgradable`,
    `${summary.incompatible ?? 0} incompatible`,
    `${summary.errors ?? 0} broken`,
  ].join(' · ');
  lines.push(headline);
  lines.push('');
  lines.push('Read-only: nothing was installed, removed, enabled or patched.');
  lines.push('');

  if (report.pluginManagerError) {
    lines.push(`plugin manager unavailable: ${report.pluginManagerError}`);
    lines.push('');
  }

  const plugins = report.plugins ?? [];
  lines.push('## 1. Installed packages');
  lines.push('');
  if (!plugins.length) {
    lines.push('No profile packages were reported.');
  } else {
    const rows = plugins
      .slice()
      .sort((a, b) => {
        const rank = (status) => ['incompatible', 'error', 'update', 'unknown', 'local', 'ok'].indexOf(status);
        const delta = rank(a.status) - rank(b.status);
        return delta !== 0 ? delta : String(a.name).localeCompare(String(b.name));
      })
      .map((plugin) => [
        plugin.name,
        plugin.installed,
        plugin.latest ?? (plugin.status === 'ok' ? '=' : '—'),
        STATUS_LABEL[plugin.status] ?? plugin.status,
        plugin.enabled ? plugin.channel : `${plugin.channel} (disabled)`,
        plugin.note ?? '',
      ]);
    lines.push(table(['package', 'installed', 'latest', 'status', 'channel', 'note'], rows));
  }
  lines.push('');

  const compatibility = report.compatibility ?? [];
  lines.push('## 2. DSH compatibility');
  lines.push('');
  if (!compatibility.length) {
    lines.push('Every installed package accepts the running DSH version.');
  } else {
    lines.push('These packages declare requirements the running DSH version does not satisfy:');
    lines.push('');
    lines.push(table(
      ['package', 'version', 'runtime', 'scope', 'requirements'],
      compatibility.map((entry) => [
        entry.name,
        entry.installed,
        entry.runtime,
        entry.scope,
        (entry.requirements ?? []).join('; '),
      ]),
    ));
    lines.push('');
    lines.push('Fix by pinning an older version, or by recording a version exemption for the exact package/runtime pair.');
  }
  lines.push('');

  const patches = report.patches ?? [];
  lines.push('## 3. Patch health');
  lines.push('');
  if (!patches.length) {
    lines.push('No bundle patch rows or overrides were reported.');
  } else {
    lines.push(table(
      ['bundle', 'rows', 'overrides', 'state', 'problems'],
      patches.map((row) => [
        row.bundle,
        row.rows,
        row.overrides,
        row.enabled ? 'enabled' : 'disabled',
        (row.problems ?? []).join('; '),
      ]),
    ));
    const overrides = summary.patchOverrides ?? 0;
    if (overrides > 0) {
      lines.push('');
      lines.push(`${overrides} row(s) override an id the bundle does not declare itself:`);
      lines.push('');
      for (const row of patches) {
        if (!row.overrideIds?.length) continue;
        const shown = row.overrideIds.slice(0, 8);
        const rest = row.overrideIds.length - shown.length;
        lines.push(`- \`${row.bundle}\` → ${shown.map((id) => `\`${id}\``).join(', ')}${rest > 0 ? ` (+ ${rest} more)` : ''}`);
      }
      lines.push('');
      lines.push('These are the rows most likely to break silently on upgrade: the override keeps pointing at an id the new version may have renamed or dropped.');
    }
  }
  lines.push('');

  const skills = report.skills ?? [];
  lines.push('## 4. Skills');
  lines.push('');
  if (report.skillsError) {
    lines.push(`skill catalog unavailable: ${report.skillsError}`);
  } else if (!skills.length) {
    lines.push('No skills were reported.');
  } else {
    lines.push(table(
      ['skill', 'source', 'invocation', 'state', 'path'],
      skills.map((row) => [
        row.name,
        row.source,
        row.invocation,
        row.shadowed ? `shadowed by ${row.shadowedBy}` : 'active',
        row.path ?? '',
      ]),
    ));
    const shadowed = summary.shadowedSkills ?? 0;
    if (shadowed > 0) {
      lines.push('');
      lines.push(`${shadowed} skill name(s) are defined more than once. Only the highest-priority source loads; the rest are dead weight and a common cause of "my edit did nothing".`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
