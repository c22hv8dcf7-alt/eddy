const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codingAssistant = require('./coding-assistant');
const appStudio = require('./app-studio');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.LSTORE_DATA_DIR || path.join(__dirname, 'data');
const RELEASES_DIR = path.join(DATA_DIR, 'releases');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const TOKEN_FILE = path.join(DATA_DIR, 'admin-token');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_DIR = path.resolve(process.env.LSTORE_WORKSPACE_DIR || path.join(__dirname, '..'));
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;
const codingJobs = new Map();
let activeCodingJobId = null;
let codingProposalInProgress = false;

ensureDirectories();
const ADMIN_TOKEN = loadAdminToken();
if (process.env.LSTORE_PUBLIC_URL && !process.env.LSTORE_PUBLIC_URL.startsWith('https://')) {
  throw new Error('LSTORE_PUBLIC_URL must use HTTPS.');
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/coding/status', requireLocalRequest, async (req, res, next) => {
  try {
    res.json(await codingAssistant.getStatus(WORKSPACE_DIR));
  } catch (error) {
    next(error);
  }
});

app.post('/api/studio/proposals', requireLocalRequest, async (req, res, next) => {
  if (codingProposalInProgress) {
    return res.status(409).json({ error: 'The local AI is already working. Wait for it to finish before starting another draft.' });
  }
  codingProposalInProgress = true;
  try {
    const proposal = await appStudio.createProposal(req.body?.name, req.body?.idea, req.body?.screenshot);
    res.status(201).json(proposal);
  } catch (error) {
    next(error);
  } finally {
    codingProposalInProgress = false;
  }
});

app.post('/api/studio/proposals/:id/revise', requireLocalRequest, async (req, res, next) => {
  if (codingProposalInProgress) {
    return res.status(409).json({ error: 'The local AI is already working. Wait for it to finish before asking for another change.' });
  }
  codingProposalInProgress = true;
  try {
    const proposal = await appStudio.reviseProposal(req.params.id, req.body?.instruction, req.body?.screenshot);
    res.status(201).json(proposal);
  } catch (error) {
    next(error);
  } finally {
    codingProposalInProgress = false;
  }
});

app.post('/api/studio/projects/:slug/revisions', requireLocalRequest, async (req, res, next) => {
  if (codingProposalInProgress) {
    return res.status(409).json({ error: 'The local AI is already working. Wait for it to finish before asking for another change.' });
  }
  codingProposalInProgress = true;
  try {
    const app = readApps().find((entry) => entry.slug === req.params.slug && entry.localProject);
    if (!app) {
      return res.status(404).json({ error: 'Saved app project not found.' });
    }
    const proposal = await appStudio.reviseSavedProject(DATA_DIR, app.slug, req.body?.instruction, req.body?.screenshot);
    res.status(201).json(proposal);
  } catch (error) {
    next(error);
  } finally {
    codingProposalInProgress = false;
  }
});

app.get('/api/studio/projects', requireLocalRequest, (req, res, next) => {
  try {
    const projects = readApps()
      .filter((entry) => entry.localProject)
      .map((entry) => ({
        name: entry.name,
        slug: entry.slug,
        summary: entry.summary,
        createdAt: entry.createdAt,
        installed: Boolean(entry.installedAppPath && fs.existsSync(entry.installedAppPath)),
        revisions: appStudio.listProjectRevisions(DATA_DIR, entry.slug),
      }));
    res.json(projects);
  } catch (error) {
    next(error);
  }
});

app.get('/api/studio/projects/:slug/preview', requireLocalRequest, (req, res, next) => {
  try {
    const app = readApps().find((entry) => entry.slug === req.params.slug && entry.localProject);
    if (!app) {
      return res.status(404).json({ error: 'Saved app project not found.' });
    }
    const preview = appStudio.getSavedProjectPreview(DATA_DIR, app.slug);
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'");
    res.set('Cache-Control', 'no-store');
    res.type('html').send(preview);
  } catch (error) {
    next(error);
  }
});

app.post('/api/studio/proposals/:id/create', requireLocalRequest, (req, res, next) => {
  try {
    const apps = readApps();
    const proposal = appStudio.getProposal(req.params.id);
    if (!proposal) {
      return res.status(404).json({ error: 'This app draft expired. Please create a new draft.' });
    }
    if (proposal.projectSlug) {
      const entry = apps.find((app) => app.slug === proposal.projectSlug && app.localProject);
      if (!entry) {
        return res.status(404).json({ error: 'The app this change belongs to could not be found.' });
      }
      const project = appStudio.saveProject(DATA_DIR, req.params.id);
      entry.summary = project.summary;
      entry.updatedAt = new Date().toISOString();
      try {
        writeApps(apps);
      } catch (error) {
        project.rollback();
        throw error;
      }
      project.commit();
      return res.json({
        name: project.name,
        slug: project.slug,
        summary: project.summary,
        saved: true,
        updated: true,
        message: `Changes to ${project.name} were saved in LStore. Try the updated app, or choose Update installed app when you’re ready.`,
      });
    }
    if (apps.some((entry) => entry.slug === proposal.slug)) {
      return res.status(409).json({ error: 'An app project with that name already exists. Choose a different name.' });
    }
    const project = appStudio.saveProject(DATA_DIR, req.params.id);

    const appEntry = {
      id: cryptoId(),
      name: project.name,
      slug: project.slug,
      summary: project.summary,
      localProject: true,
      createdAt: new Date().toISOString(),
      releases: [],
    };
    apps.push(appEntry);
    try {
      writeApps(apps);
    } catch (error) {
      appStudio.deleteProject(project.directory, DATA_DIR);
      throw error;
    }

    res.status(201).json({
      name: project.name,
      slug: project.slug,
      summary: project.summary,
      saved: true,
      message: `${project.name} was saved in LStore. You can try it now and install it whenever you’re ready.`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/studio/projects/:slug/install', requireLocalRequest, (req, res, next) => {
  try {
    const apps = readApps();
    const entry = apps.find((app) => app.slug === req.params.slug && app.localProject);
    if (!entry) {
      return res.status(404).json({ error: 'Saved app project not found.' });
    }
    const expectedAppPath = path.join(os.homedir(), 'Applications', `${entry.slug}.app`);
    const updating = Boolean(entry.installedAppPath && fs.existsSync(entry.installedAppPath));
    if (updating && entry.installedAppPath !== expectedAppPath) {
      return res.status(409).json({ error: 'The installed app is not in its expected Applications folder. Move it back before updating.' });
    }

    const project = {
      name: entry.name,
      slug: entry.slug,
      directory: path.join(DATA_DIR, 'projects', entry.slug),
    };
    const install = appStudio.installProject(
      project,
      path.join(os.homedir(), 'Applications'),
      path.join(__dirname, 'templates', 'AppShell.swift'),
      updating,
    );
    entry.installedAppPath = install.path;
    if (!updating) {
      try {
        writeApps(apps);
      } catch (error) {
        fs.rmSync(install.path, { recursive: true, force: true });
        throw error;
      }
    }

    let message = `${entry.name} was installed in your Applications folder.`;
    if (updating) {
      message = `${entry.name} was updated in Applications. Quit and reopen it to use your changes.`;
    } else {
      try {
        appStudio.launchProject(install.path);
      } catch (error) {
        message = error.message;
      }
    }
    res.status(updating ? 200 : 201).json({
      name: entry.name,
      slug: entry.slug,
      installed: true,
      updated: updating,
      appPath: install.path,
      message,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/studio/projects/:slug/export', requireLocalRequest, (req, res, next) => {
  try {
    const entry = readApps().find((app) => app.slug === req.params.slug && app.localProject);
    if (!entry) {
      return res.status(404).json({ error: 'Saved app project not found.' });
    }
    const project = {
      name: entry.name,
      slug: entry.slug,
      directory: path.join(DATA_DIR, 'projects', entry.slug),
    };
    const exported = appStudio.exportProject(
      project,
      path.join(os.homedir(), 'Downloads', 'LStore Exports'),
      path.join(__dirname, 'templates', 'AppShell.swift'),
    );
    res.status(201).json({
      name: entry.name,
      slug: entry.slug,
      archivePath: exported.path,
      message: `A shareable copy of ${entry.name} is ready for you to review. It has not been sent or uploaded. Find it here: ${exported.path}`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/studio/projects/:slug/revisions/:revisionId/restore', requireLocalRequest, (req, res, next) => {
  try {
    const apps = readApps();
    const entry = apps.find((app) => app.slug === req.params.slug && app.localProject);
    if (!entry) {
      return res.status(404).json({ error: 'Saved app project not found.' });
    }
    const restored = appStudio.restoreProjectRevision(DATA_DIR, entry.slug, req.params.revisionId);
    const previousSummary = entry.summary;
    entry.summary = restored.summary;
    entry.updatedAt = new Date().toISOString();
    try {
      writeApps(apps);
    } catch (error) {
      entry.summary = previousSummary;
      restored.rollback();
      throw error;
    }
    res.json({
      name: restored.name,
      slug: restored.slug,
      summary: restored.summary,
      restored: true,
      message: `${restored.name} was restored in LStore. The installed app was not changed; choose Update installed app if you want to replace it.`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/coding/proposals', requireLocalRequest, async (req, res, next) => {
  if (codingProposalInProgress) {
    return res.status(409).json({ error: 'The local coding helper is already preparing a suggestion. Wait for it to finish.' });
  }
  codingProposalInProgress = true;
  try {
    const proposal = await codingAssistant.createProposal(WORKSPACE_DIR, req.body?.request, req.body?.screenshot);
    res.status(201).json(proposal);
  } catch (error) {
    next(error);
  } finally {
    codingProposalInProgress = false;
  }
});

app.post('/api/coding/proposals/:id/publish', requireLocalRequest, (req, res, next) => {
  try {
    if (activeCodingJobId) {
      return res.status(409).json({ error: 'An Eddy update is already building. Wait for it to finish before starting another.' });
    }

    const eddy = getAppBySlug('eddy');
    const latest = getLatestRelease(eddy);
    if (!latest) {
      return res.status(409).json({ error: 'Publish a signed Eddy release before creating an update.' });
    }
    const version = nextPatchVersion(latest.version);
    const notes = String(req.body?.notes || 'Local coding assistant update').trim().slice(0, 300);
    const scriptPath = path.join(WORKSPACE_DIR, 'lstore/scripts/publish-eddy.sh');
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: 'The Eddy release script could not be found in the project.' });
    }

    const applied = codingAssistant.applyProposal(WORKSPACE_DIR, req.params.id);
    const job = {
      id: crypto.randomUUID(),
      status: 'building',
      version,
      output: `Applied your reviewed code changes. Building and signing Eddy ${version}…\n`,
      createdAt: Date.now(),
      process: null,
    };
    codingJobs.set(job.id, job);
    activeCodingJobId = job.id;

    const pathValue = [
      path.dirname(process.execPath),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.PATH || '',
    ].filter(Boolean).join(path.delimiter);
    const child = spawn('/bin/sh', [scriptPath, version, notes], {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PATH: pathValue,
        LSTORE_URL: `http://127.0.0.1:${PORT}`,
        LSTORE_ADMIN_TOKEN: ADMIN_TOKEN,
        LSTORE_WORKSPACE_DIR: WORKSPACE_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.process = child;
    child.stdout.on('data', (chunk) => appendJobOutput(job, chunk));
    child.stderr.on('data', (chunk) => appendJobOutput(job, chunk));
    child.once('error', (error) => finishCodingJob(job, 'failed', `Could not start the Eddy build: ${error.message}`));
    child.once('close', (code) => {
      finishCodingJob(
        job,
        code === 0 ? 'complete' : 'failed',
        code === 0
          ? `Eddy ${version} was built and published. Eddy will download it when it next checks for updates.`
          : `The build or upload stopped with exit code ${code}. Your reviewed code changes remain in the Eddy project; no successful release was reported.`,
      );
    });

    res.status(202).json({
      id: job.id,
      version: job.version,
      status: job.status,
      message: applied.message,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/coding/jobs/:id', requireLocalRequest, (req, res) => {
  const job = codingJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'This build status is no longer available.' });
  }
  res.json({
    id: job.id,
    version: job.version,
    status: job.status,
    output: job.output,
    message: job.message || '',
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(RELEASES_DIR, 'tmp'),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_RELEASE_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    const accepted = file.fieldname === 'artifact'
      ? file.originalname.endsWith('.app.tar.gz')
      : file.fieldname === 'installer'
        ? file.originalname.endsWith('.dmg')
        : false;
    cb(accepted ? null : new Error('Upload a Tauri .app.tar.gz updater archive and optional .dmg installer.'), accepted);
  },
});

app.get('/api/apps', (req, res) => {
  const apps = readApps();
  const formatted = apps.map((entry) => ({
    ...entry,
    latestRelease: getLatestRelease(entry),
    updateUrl: `${getBaseUrl(req)}/api/apps/${entry.slug}/latest.json`,
  }));
  res.json(formatted);
});

app.post('/api/apps', requireAdmin, (req, res) => {
  const { appName, slug } = req.body || {};
  const name = String(appName || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'App name is required.' });
  }

  const apps = readApps();
  const appSlug = sanitizeSlug(slug || name);
  const existing = apps.find((entry) => entry.slug === appSlug);
  if (existing) {
    return res.status(409).json({ error: 'An app with that slug already exists.' });
  }

  const newApp = {
    id: cryptoId(),
    name,
    slug: appSlug,
    createdAt: new Date().toISOString(),
    releases: [],
  };

  apps.push(newApp);
  writeApps(apps);
  res.status(201).json(newApp);
});

app.get('/api/apps/:slug', (req, res) => {
  const app = getAppBySlug(req.params.slug);
  if (!app) {
    return res.status(404).json({ error: 'App not found.' });
  }
  res.json({ ...app, latestRelease: getLatestRelease(app) });
});

app.get('/api/releases/:slug', (req, res) => {
  const app = getAppBySlug(req.params.slug);
  if (!app) {
    return res.status(404).json({ error: 'App not found.' });
  }
  res.json(app.releases.sort(sortByVersionDesc));
});

app.get('/api/releases/:slug/latest', (req, res) => {
  const app = getAppBySlug(req.params.slug);
  if (!app) {
    return res.status(404).json({ error: 'App not found.' });
  }

  const latest = getLatestRelease(app);
  if (!latest) {
    return res.status(404).json({ error: 'No releases have been published yet.' });
  }

  res.json(latest);
});

app.get('/api/apps/:slug/latest.json', (req, res) => {
  const app = getAppBySlug(req.params.slug);
  if (!app) {
    return res.status(404).json({ error: 'App not found.' });
  }

  const release = getLatestRelease(app);
  if (!release) {
    return res.status(404).json({ error: 'No release available.' });
  }

  const latestUrl = `${getBaseUrl(req)}${release.downloadUrl}`;
  const manifest = {
    version: release.version,
    notes: release.notes || 'New app update',
    pub_date: release.createdAt,
    platforms: {
      [release.platform]: {
        signature: release.signature,
        url: latestUrl,
      },
    },
  };

  res.set('Cache-Control', 'no-store');
  res.json(manifest);
});

app.get('/api/downloads/:slug/:version/:kind', (req, res) => {
  const app = getAppBySlug(req.params.slug);
  if (!app) {
    return res.status(404).json({ error: 'App not found.' });
  }

  const release = app.releases.find((entry) => entry.version === req.params.version);
  if (!release) {
    return res.status(404).json({ error: 'Release not found.' });
  }

  const fileName = req.params.kind === 'updater'
    ? release.filename
    : req.params.kind === 'installer'
      ? release.installerFilename
      : null;
  if (!fileName) {
    return res.status(404).json({ error: 'Requested release file not found.' });
  }

  const filePath = path.join(RELEASES_DIR, app.slug, release.version, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  res.download(filePath);
});

app.post('/api/releases', requireAdmin, upload.fields([
  { name: 'artifact', maxCount: 1 },
  { name: 'installer', maxCount: 1 },
]), (req, res) => {
  const { appId, version, notes, channel = 'stable', platform = 'darwin-aarch64' } = req.body || {};
  const appSlug = String(appId || '').trim() ? sanitizeSlug(appId) : '';
  const releaseVersion = String(version || '').trim();
  const signature = String(req.body?.signature || '').trim();
  const artifact = req.files?.artifact?.[0];
  const installer = req.files?.installer?.[0];

  if (!appSlug) {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(400).json({ error: 'App ID is required.' });
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(400).json({ error: 'Use a version such as 1.2.3 or 1.2.3-beta.1.' });
  }

  if (!artifact) {
    removeUpload(installer);
    return res.status(400).json({ error: 'Upload the signed Tauri .app.tar.gz updater archive.' });
  }

  if (signature.length < 20 || signature === 'unsigned') {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(400).json({ error: 'A valid Tauri .sig signature is required for auto-updates.' });
  }

  if (!['darwin-aarch64', 'darwin-x86_64'].includes(platform)) {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(400).json({ error: 'Unsupported macOS platform.' });
  }

  const apps = readApps();
  const app = apps.find((entry) => entry.slug === appSlug || entry.id === appSlug);
  if (!app) {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(404).json({ error: 'App not found.' });
  }

  if (channel !== 'stable') {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(400).json({ error: 'Only stable releases are currently supported.' });
  }

  if (app.releases.some((entry) => entry.version === releaseVersion && entry.platform === platform)) {
    removeUpload(artifact);
    removeUpload(installer);
    return res.status(409).json({ error: 'That version has already been published for this platform.' });
  }

  const targetDir = path.join(RELEASES_DIR, app.slug, releaseVersion);
  fs.mkdirSync(targetDir, { recursive: true });

  const finalFileName = `${app.slug}-${releaseVersion}-${platform}.app.tar.gz`;
  const installerFileName = installer ? `${app.slug}-${releaseVersion}.dmg` : null;
  fs.renameSync(artifact.path, path.join(targetDir, finalFileName));
  if (installer) {
    fs.renameSync(installer.path, path.join(targetDir, installerFileName));
  }

  const release = {
    id: cryptoId(),
    version: releaseVersion,
    notes: String(notes || 'New app update'),
    channel: String(channel),
    platform: String(platform),
    filename: finalFileName,
    installerFilename: installerFileName,
    createdAt: new Date().toISOString(),
    downloadUrl: `/api/downloads/${app.slug}/${releaseVersion}/updater`,
    installerUrl: installerFileName ? `/api/downloads/${app.slug}/${releaseVersion}/installer` : null,
    signature,
  };

  app.releases.push(release);
  app.releases.sort(sortByVersionDesc);
  writeApps(apps);

  res.status(201).json({ app, release });
});

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((error, req, res, next) => {
  if (req.file) removeUpload(req.file);
  if (req.files) Object.values(req.files).flat().forEach(removeUpload);
  if (Number.isInteger(error.status)) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Release files must be 2 GB or smaller.' });
  }
  console.error(error);
  res.status(500).json({ error: error.message || 'LStore encountered an error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`LStore is running at http://${HOST}:${PORT}`);
});

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.mkdirSync(path.join(RELEASES_DIR, 'tmp'), { recursive: true });
  if (!fs.existsSync(APPS_FILE)) {
    fs.writeFileSync(APPS_FILE, '[]', 'utf8');
  }
}

function readApps() {
  const parsed = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('LStore app data is invalid; expected a JSON array.');
  }
  return parsed;
}

function writeApps(apps) {
  const tempFile = `${APPS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(apps, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, APPS_FILE);
}

function sanitizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

function getAppBySlug(slug) {
  const apps = readApps();
  return apps.find((entry) => entry.slug === slug || entry.id === slug) || null;
}

function getLatestRelease(app) {
  if (!app || !Array.isArray(app.releases)) {
    return null;
  }

  return [...app.releases]
    .filter((release) => release.channel === 'stable' && release.signature && release.signature !== 'unsigned')
    .sort(sortByVersionDesc)[0] || null;
}

function sortByVersionDesc(a, b) {
  return compareVersions(b.version, a.version);
}

function compareVersions(a, b) {
  const parse = (version) => {
    const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) {
      throw new Error(`Invalid release version: ${version}`);
    }
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || [] };
  };
  const x = parse(a);
  const y = parse(b);

  for (let i = 0; i < x.core.length; i += 1) {
    const left = x.core[i];
    const right = y.core[i];
    if (left > right) return 1;
    if (left < right) return -1;
  }

  if (!x.prerelease.length || !y.prerelease.length) {
    if (x.prerelease.length) return -1;
    if (y.prerelease.length) return 1;
    return 0;
  }

  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i += 1) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    if (x.prerelease[i] === y.prerelease[i]) continue;
    const leftNumber = /^\d+$/.test(x.prerelease[i]);
    const rightNumber = /^\d+$/.test(y.prerelease[i]);
    if (leftNumber && rightNumber) {
      return Number(x.prerelease[i]) > Number(y.prerelease[i]) ? 1 : -1;
    }
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return x.prerelease[i] > y.prerelease[i] ? 1 : -1;
  }

  return 0;
}

function cryptoId() {
  return crypto.randomUUID();
}

function getBaseUrl(req) {
  return (process.env.LSTORE_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function loadAdminToken() {
  if (process.env.LSTORE_ADMIN_TOKEN) {
    if (process.env.LSTORE_ADMIN_TOKEN.length < 32) {
      throw new Error('LSTORE_ADMIN_TOKEN must be at least 32 characters.');
    }
    return process.env.LSTORE_ADMIN_TOKEN;
  }
  if (fs.existsSync(TOKEN_FILE)) {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (token.length < 32) {
      throw new Error('Stored LStore admin token is invalid; remove it and restart to generate a new token.');
    }
    fs.chmodSync(TOKEN_FILE, 0o600);
    return token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  console.log(`Initial LStore admin token saved to ${TOKEN_FILE}.`);
  return token;
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBuffer = Buffer.from(ADMIN_TOKEN);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length
      || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return res.status(401).json({ error: 'Enter the LStore admin token to make changes.' });
  }
  next();
}

function requireLocalRequest(req, res, next) {
  const address = req.socket.remoteAddress || '';
  const isLoopback = address === '127.0.0.1'
    || address === '::1'
    || address.startsWith('::ffff:127.');
  const originHeader = req.get('origin');
  let sameOrigin = req.method === 'GET' && !originHeader;
  if (originHeader) {
    try {
      const origin = new URL(originHeader);
      sameOrigin = origin.protocol === 'http:' && origin.host === req.get('host');
    } catch {
      sameOrigin = false;
    }
  }
  if (!isLoopback || !sameOrigin) {
    return res.status(403).json({ error: 'The local coding helper is available only inside the LStore app on this Mac.' });
  }
  next();
}

function removeUpload(file) {
  if (file?.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }

  function nextPatchVersion(version) {
    const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      throw Object.assign(new Error(`Cannot automatically increment Eddy version ${version}.`), { status: 409 });
    }
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  }

  function appendJobOutput(job, chunk) {
    job.output = `${job.output}${chunk.toString('utf8')}`.slice(-30000);
  }

  function finishCodingJob(job, status, message) {
    if (job.status !== 'building') return;
    job.status = status;
    job.message = message;
    job.process = null;
    if (activeCodingJobId === job.id) activeCodingJobId = null;
  }
}
