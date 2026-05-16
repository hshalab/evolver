const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { getEvolverInstallRoot } = require('./gep/paths');

const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

// Force Update: triggered by Hub when version is critically outdated.
// Extracted from src/evolve.js so both the evolve main loop and heartbeat
// thread can trigger it independently (heartbeat-only workers need this
// because they never reach the evolve run() loop that consumes the pending
// force_update directive).
//
// CRITICAL (issue #51): this function MUST operate on the evolver INSTALL
// directory, NOT getRepoRoot(). getRepoRoot() preferentially returns the
// user's surrounding project (process.cwd()'s nearest .git ancestor).
// Using it here would delete the user's project files and copy the
// evolver package on top of them. Always use getEvolverInstallRoot(),
// which resolves to the package containing this file regardless of
// install layout (global npm / local node_modules / dev clone).
function executeForceUpdate(forceUpdate) {
  const INSTALL_ROOT = getEvolverInstallRoot();

  // Defense in depth: if a future refactor breaks path resolution and
  // INSTALL_ROOT no longer points at the evolver package (no package.json
  // / wrong package name), refuse the update rather than risk
  // overwriting an unrelated directory. This is the last guard between
  // the deletion loop and the user's data.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'));
    if (!pkg || (pkg.name !== '@evomap/evolver' && pkg.name !== 'evolver')) {
      console.warn('[ForceUpdate] Refusing — ' + INSTALL_ROOT +
        '/package.json has name="' + (pkg && pkg.name) +
        '", expected "@evomap/evolver". Aborting to avoid data loss.');
      return false;
    }
  } catch (e) {
    console.warn('[ForceUpdate] Refusing — cannot read ' + INSTALL_ROOT +
      '/package.json: ' + (e && e.message || e));
    return false;
  }

  const requiredVersion = String(forceUpdate.required_version || '').replace(/^>=/, '');
  console.log('[ForceUpdate] Starting multi-channel update (target: >=' + requiredVersion +
    ', install root: ' + INSTALL_ROOT + ')');

  function parseVer(v) {
    var m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  }
  function isAtLeast(current, required) {
    var c = parseVer(current), r = parseVer(required);
    for (var i = 0; i < 3; i++) {
      if (c[i] > r[i]) return true;
      if (c[i] < r[i]) return false;
    }
    return true;
  }
  function getCurrentVersion() {
    try {
      var pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch (_) { return '0.0.0'; }
  }

  // Use os.tmpdir() for staging — INSTALL_ROOT's parent (e.g.
  // /usr/lib/node_modules/@evomap when globally installed) is often not
  // writable, unlike the previous user-project parent.
  const TMP_TARGET = path.join(os.tmpdir(), '.evolver-update-tmp-' + process.pid);

  // Channel 1: GitHub Release (via degit)
  try {
    console.log('[ForceUpdate] Channel 1: GitHub Release download...');
    try { fs.rmSync(TMP_TARGET, { recursive: true, force: true }); } catch (_) {}
    execSync('npx -y degit EvoMap/evolver ' + JSON.stringify(TMP_TARGET), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000, windowsHide: true, maxBuffer: MAX_EXEC_BUFFER,
    });
    var tmpPkg = JSON.parse(fs.readFileSync(path.join(TMP_TARGET, 'package.json'), 'utf8'));
    if (tmpPkg.version && isAtLeast(tmpPkg.version, requiredVersion)) {
      var entries = fs.readdirSync(INSTALL_ROOT, { withFileTypes: true });
      for (var ei = 0; ei < entries.length; ei++) {
        var eName = entries[ei].name;
        if (eName === 'node_modules' || eName === 'memory' || eName === '.git' || eName === 'MEMORY.md') continue;
        try { fs.rmSync(path.join(INSTALL_ROOT, eName), { recursive: true, force: true }); } catch (_) {}
      }
      var newEntries = fs.readdirSync(TMP_TARGET, { withFileTypes: true });
      for (var ni = 0; ni < newEntries.length; ni++) {
        var src = path.join(TMP_TARGET, newEntries[ni].name);
        var dst = path.join(INSTALL_ROOT, newEntries[ni].name);
        fs.cpSync(src, dst, { recursive: true });
      }
      try { fs.rmSync(TMP_TARGET, { recursive: true, force: true }); } catch (_) {}
      console.log('[ForceUpdate] GitHub Release update successful: ' + tmpPkg.version);
      return true;
    }
    try { fs.rmSync(TMP_TARGET, { recursive: true, force: true }); } catch (_) {}
  } catch (e) {
    console.warn('[ForceUpdate] GitHub Release failed:', e && e.message || e);
    try { fs.rmSync(TMP_TARGET, { recursive: true, force: true }); } catch (_) {}
  }

  // Channel 2: npm
  try {
    console.log('[ForceUpdate] Channel 2: npm install...');
    var npmCmd = 'npm install -g @evomap/evolver@latest';
    execSync(npmCmd, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000, windowsHide: true, maxBuffer: MAX_EXEC_BUFFER,
    });
    var newVerNpm = getCurrentVersion();
    if (isAtLeast(newVerNpm, requiredVersion)) {
      console.log('[ForceUpdate] npm update successful: ' + newVerNpm);
      return true;
    }
  } catch (e) {
    console.warn('[ForceUpdate] npm failed:', e && e.message || e);
  }

  // Channel 3: GitHub release (manual download URL only)
  try {
    var releaseUrl = forceUpdate.release_url;
    if (releaseUrl) {
      console.log('[ForceUpdate] Channel 3: GitHub release -- manual download required');
      console.log('[ForceUpdate] Visit: ' + releaseUrl);
    }
  } catch (_) {}

  console.warn('[ForceUpdate] All automatic channels exhausted. Current version: ' + getCurrentVersion());
  return false;
}

module.exports = { executeForceUpdate };
