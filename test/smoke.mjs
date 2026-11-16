import assert from 'node:assert/strict';
import { collectReport } from '../src/report.js';
import { renderReport } from '../src/render.js';

const bundles = [
  {
    name: 'dsh-cost-meter', version: '1.9.65', official: false, availability: 'profile',
    installed: true, enabled: true, update: 'registry', source: '1.9.65', removable: true,
    rows: [{ entryId: 'cost-meter' }], overrides: [],
  },
  {
    name: 'dsh-oil-ui', version: '0.3.1', official: false, availability: 'profile',
    installed: true, enabled: true, source: 'file:pkgs/oil-ui/dsh-oil-ui-0.3.1.tgz', removable: true,
    rows: [{ entryId: 'oil-ui' }], overrides: ['theme-default'],
  },
  {
    name: 'dsh-broken', version: '0.1.0', official: false, availability: 'profile',
    installed: true, enabled: false, removable: true, rows: [], overrides: [],
    error: {
      code: 'incompatible-version',
      diagnostic: 'engines.dsh wants >=0.3.0',
      incompatible: [{ name: 'dsh-broken', version: '0.1.0', runtimeVersion: '0.2.2-rc.2', requirements: { 'engines.dsh': '>=0.3.0' } }],
    },
  },
];

const pluginManager = {
  async listBundles() { return bundles; },
  async listVersions(name) {
    if (name === 'dsh-cost-meter') {
      return {
        status: 'listed', installed: '1.9.65', registry: null, attempts: [], omitted: 0,
        versions: [{ version: '1.10.0', tags: ['latest'], prerelease: false, bundle: true }],
      };
    }
    if (name === 'dsh-oil-ui') {
      return { status: 'refused', problem: 'not-updatable', reason: 'file: spec is local', attempts: [] };
    }
    return { status: 'refused', problem: 'not-found', reason: '404', attempts: [] };
  },
};

const skills = {
  async list() {
    return [
      { name: 'oil-ui', source: 'project-dsh', invocation: 'model', path: '/p/.dsh/skills/oil-ui' },
      { name: 'oil-ui', source: 'user-dsh', invocation: 'model', path: '/u/skills/oil-ui' },
      { name: 'archify', source: 'runtime', invocation: 'model' },
    ];
  },
};

const report = await collectReport({ pluginManager, skills }, { timeoutMs: 5000 });

assert.equal(report.readOnly, true);
assert.equal(report.summary.plugins, 3, 'all three profile packages appear');
assert.equal(report.summary.updates, 1, 'only the registry package with a newer version counts');
assert.equal(report.summary.incompatible, 1, 'the incompatible bundle is counted once');
assert.equal(report.summary.shadowedSkills, 1, 'the lower-priority duplicate skill is shadowed');
assert.equal(report.summary.patchOverrides, 1, 'the override row is counted');

const byName = Object.fromEntries(report.plugins.map((row) => [row.name, row]));
assert.equal(byName['dsh-cost-meter'].status, 'update');
assert.equal(byName['dsh-cost-meter'].latest, '1.10.0');
assert.equal(byName['dsh-oil-ui'].status, 'local', 'a file: spec has no upgrade channel');
assert.equal(byName['dsh-oil-ui'].channel, 'file');
assert.equal(byName['dsh-broken'].status, 'incompatible');

assert.equal(report.compatibility.length, 1);
assert.deepEqual(report.compatibility[0].requirements, ['engines.dsh: >=0.3.0']);

const shadowed = report.skills.find((row) => row.shadowed === true);
assert.equal(shadowed.source, 'user-dsh');
assert.equal(shadowed.shadowedBy, 'project-dsh');

const markdown = renderReport(report);
for (const heading of ['## 1. Installed packages', '## 2. DSH compatibility', '## 3. Patch health', '## 4. Skills']) {
  assert.ok(markdown.includes(heading), `renderer emits ${heading}`);
}
assert.ok(markdown.includes('| dsh-cost-meter | 1.9.65 | 1.10.0 | update |'), 'the upgrade row renders');

// A host that exposes nothing must still produce a readable report.
const bare = await collectReport({}, {});
assert.equal(bare.plugins.length, 0);
assert.ok(bare.pluginManagerError, 'a missing plugin manager is reported, not thrown');
assert.ok(renderReport(bare).includes('No profile packages were reported'));

console.log('smoke: 4 sections, 3 statuses, shadowing and degradation all OK');
console.log('---');
console.log(markdown);
