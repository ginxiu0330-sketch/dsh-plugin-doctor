/**
 * dsh-plugin-doctor — a read-only health check for the profile DSH is running.
 *
 * The plugin registers exactly one tool and touches no files: it asks the host
 * services what is installed, what the registry offers, what the running DSH
 * version rejects, and which skills are shadowed. Every write path lives in a
 * later release behind a dry run.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { collectReport } from './report.js';
import { renderReport } from './render.js';

/** Cordis plugin name. */
export const name = 'plugin-doctor';

/** The host services this plugin reads. Cordis injects them before `apply` runs. */
export const inject = ['tools', 'pluginManager', 'skills'];

const DESCRIPTION = [
  'Read-only health check for this DSH profile. Reports, in one pass:',
  '(1) every installed plugin package with its installed version, the newest published version and a status of',
  'ok / update / incompatible / local / error; (2) packages whose declared engines.dsh or DSH peer ranges reject the',
  'running DSH version, including a candidate upgrade that would break it; (3) bundle patch rows that override ids the',
  'bundle never declares — the rows that break silently on upgrade; (4) skills whose name is defined by more than one',
  'source, where only the highest-priority copy loads. Use it before upgrading plugins, after editing cordis.patch.yml,',
  'or when a skill edit appears to do nothing. It installs, removes, enables and patches nothing.',
].join(' ');

const objectOf = (properties) => ({ type: 'object', additionalProperties: false, properties });

/** Canonical report schema. */
const REPORT_SCHEMA = objectOf({
  checkedAt: { type: 'string', description: 'ISO 8601 timestamp of the collection.' },
  readOnly: { type: 'boolean', description: 'Always true for this tool.' },
  runtime: { type: 'string', description: 'The running DSH version, when it could be read.' },
  pluginManagerError: { type: 'string', description: 'Set when the plugin manager service was unavailable.' },
  skillsError: { type: 'string', description: 'Set when the skill catalog was unavailable.' },
  summary: objectOf({
    plugins: { type: 'integer' },
    updates: { type: 'integer' },
    incompatible: { type: 'integer' },
    errors: { type: 'integer' },
    local: { type: 'integer' },
    unknown: { type: 'integer' },
    skills: { type: 'integer' },
    shadowedSkills: { type: 'integer' },
    patchOverrides: { type: 'integer' },
  }),
  plugins: {
    type: 'array',
    items: objectOf({
      name: { type: 'string', description: 'Package name as the profile lists it.' },
      installed: { type: 'string' },
      latest: { type: 'string', description: 'Newest published version, present only for a registry package with an update.' },
      status: { type: 'string', enum: ['ok', 'update', 'incompatible', 'local', 'error', 'unknown'] },
      channel: { type: 'string', description: 'registry, git, file or tarball.' },
      enabled: { type: 'boolean' },
      official: { type: 'boolean', description: 'Shipped with the DSH installation rather than installed into the profile.' },
      note: { type: 'string', description: 'Why this status was chosen.' },
      deprecated: { type: 'string', description: 'Registry deprecation message on the candidate version.' },
      replacesBundle: { type: 'boolean', description: 'False when the candidate version declares no dsh.bundle and cannot replace one.' },
      targetIncompatible: { type: 'array', items: { type: 'string' }, description: 'Requirements the candidate version fails against the running DSH.' },
    }),
  },
  compatibility: {
    type: 'array',
    items: objectOf({
      name: { type: 'string' },
      installed: { type: 'string' },
      runtime: { type: 'string' },
      scope: { type: 'string', description: 'installed, or candidate <version>.' },
      requirements: { type: 'array', items: { type: 'string' } },
    }),
  },
  patches: {
    type: 'array',
    items: objectOf({
      bundle: { type: 'string' },
      rows: { type: 'integer', description: 'Patch rows this bundle inserts or configures.' },
      overrides: { type: 'integer', description: 'Rows this bundle changes without declaring them.' },
      overrideIds: { type: 'array', items: { type: 'string' }, description: 'The overridden row ids themselves.' },
      enabled: { type: 'boolean' },
      problems: { type: 'array', items: { type: 'string' } },
    }),
  },
  skills: {
    type: 'array',
    items: objectOf({
      name: { type: 'string' },
      source: { type: 'string', description: 'project-dsh, project-agents, user-dsh, user-agents, runtime or bundled.' },
      invocation: { type: 'string' },
      shadowed: { type: 'boolean', description: 'True when a higher-priority source defines the same name.' },
      shadowedBy: { type: 'string' },
      path: { type: 'string' },
    }),
  },
});

/**
 * Register the doctor tool.
 * @param {object} ctx - cordis context.
 * @param {{checkUpdatesByDefault?: boolean, timeoutMs?: number}} [config] - optional plugin config.
 */
export function apply(ctx, config = {}) {
  const defaultTimeout = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 20000;

  ctx.tools.register(defineTool({
    name: 'plugin_doctor',
    description: DESCRIPTION,
    parameters: {
      checkUpdates: {
        type: 'boolean',
        description: 'Ask the registry which packages have newer versions. Costs one registry round trip per registry spec; disable for a fast offline report.',
        default: config.checkUpdatesByDefault !== false,
      },
      checkSkills: {
        type: 'boolean',
        description: 'Include the skill catalog and flag names defined by more than one source.',
        default: true,
      },
      timeoutMs: {
        type: 'integer',
        description: 'Per-package budget in milliseconds for the registry version check.',
        default: defaultTimeout,
      },
    },
    output: {
      schema: REPORT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return await collectReport(ctx, {
        checkUpdates: args.checkUpdates !== false,
        checkSkills: args.checkSkills !== false,
        timeoutMs: args.timeoutMs,
      });
    },
  }));
}
