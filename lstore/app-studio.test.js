const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

let responseContent;
let lastModelRequest;
let modelRequests;
let runningModels;
let unloadRequests;
let server;
let studio;
let dataDirectory;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: runningModels }));
      return;
    }
    if (req.url === '/api/generate') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        unloadRequests.push(JSON.parse(body));
        runningModels = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: '' }));
      });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      lastModelRequest = JSON.parse(body);
      modelRequests.push(lastModelRequest);
      const systemPrompt = lastModelRequest.messages?.[0]?.content || '';
      let content = responseContent;
      if (lastModelRequest.messages?.some((message) => Array.isArray(message.images))) {
        content = 'A clean page with a purple header and a rounded primary button.';
      } else if (systemPrompt.includes('Choose at most five relevant file paths')) {
        content = { summary: 'Update the Save button.', files: ['dist/index.html'], terms: ['Save'] };
      } else if (systemPrompt.includes('You are a careful coding assistant for Eddy.')) {
        content = {
          summary: 'Make the Save button clearer.',
          changes: [{
            file: 'dist/index.html',
            before: '<button id="save">Save</button>',
            after: '<button id="save">Save changes</button>',
          }],
          preview: { screen: 'Eddy', element: 'Save button', before: 'Save', after: 'Save changes' },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  studio = require('./app-studio');
  modelRequests = [];
  runningModels = [];
  unloadRequests = [];
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lstore-studio-test-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test('revises, saves, previews, and builds a standalone app without installing it', async () => {
  responseContent = validResponse();
  responseContent.files[0].content = responseContent.files[0].content.replace(' defer', '');
  const proposal = await studio.createProposal('Garden Journal', 'Track plants and watering dates.');

  assert.equal(proposal.slug, 'garden-journal');
  assert.match(proposal.files[0].content, /src="app\.js" defer/);
  assert.equal(proposal.files.length, 3);
  assert.match(proposal.previewHtml, /Content-Security-Policy/);
  assert.match(proposal.previewHtml, /window\.appStorage/);
  assert.match(proposal.previewHtml, /Add a plant/);
  assert.ok(proposal.previewHtml.indexOf('window.appStorage') < proposal.previewHtml.indexOf('document.querySelector("#add")'));
  const previewScript = [...proposal.previewHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const previewWindow = { appStorage: undefined };
  vm.runInNewContext(previewScript, { window: previewWindow });
  previewWindow.appStorage.setItem('plants', JSON.stringify(['Fern']));
  assert.equal(JSON.parse(previewWindow.appStorage.getItem('plants'))[0], 'Fern');
  assert.equal(previewWindow.appStorage.length, 1);
  previewWindow.appStorage.removeItem('plants');
  assert.equal(previewWindow.appStorage.getItem('plants'), null);

  responseContent = validResponse();
  responseContent.summary = 'Adds a control to mark plants as watered.';
  responseContent.files[0].content = responseContent.files[0].content.replace(
    '<button id="add">Add a plant</button>',
    '<button id="add">Add a plant</button><button id="water">Mark watered</button>',
  );
  const revised = await studio.reviseProposal(proposal.id, 'Add a way to mark plants as watered.');
  assert.match(lastModelRequest.messages[1].content, /Current app files:/);
  assert.match(revised.previewHtml, /Mark watered/);

  const project = studio.saveProject(dataDirectory, revised.id);
  const projectDirectory = path.join(dataDirectory, 'projects', 'garden-journal');
  assert.equal(project.directory, projectDirectory);
  const originalCreatedAt = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'project.json'), 'utf8')).createdAt;
  const savedHtml = fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8');
  assert.match(savedHtml, /Content-Security-Policy/);
  assert.match(savedHtml, /<title>Garden Journal<\/title>/);
  assert.match(savedHtml, /Mark watered/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDirectory, 'project.json'), 'utf8')).name, 'Garden Journal');
  assert.match(studio.getSavedProjectPreview(dataDirectory, project.slug), /Mark watered/);

  const applicationsDirectory = path.join(dataDirectory, 'Applications');
  const app = studio.installProject(
    { ...project, directory: projectDirectory },
    applicationsDirectory,
    path.join(__dirname, 'templates', 'AppShell.swift'),
  );
  assert.equal(app.path, path.join(applicationsDirectory, 'garden-journal.app'));
  assert.equal(fs.existsSync(path.join(app.path, 'Contents', 'Resources', 'App', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(app.path, 'Contents', 'Resources', 'App', 'project.json')), false);
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app.path]).status, 0);
  assert.throws(
    () => studio.installProject({ ...project, directory: projectDirectory }, applicationsDirectory, path.join(__dirname, 'templates', 'AppShell.swift')),
    { status: 409 },
  );

  const exportsDirectory = path.join(dataDirectory, 'LStore Exports');
  const exported = studio.exportProject(
    { ...project, directory: projectDirectory },
    exportsDirectory,
    path.join(__dirname, 'templates', 'AppShell.swift'),
  );
  assert.equal(path.dirname(exported.path), exportsDirectory);
  assert.equal(fs.statSync(exported.path).mode & 0o777, 0o600);
  const extractedDirectory = path.join(dataDirectory, 'extracted-share-copy');
  const extraction = spawnSync('/usr/bin/ditto', ['-x', '-k', exported.path, extractedDirectory], { encoding: 'utf8' });
  assert.equal(extraction.status, 0, extraction.stderr);
  const exportedPackage = path.join(extractedDirectory, 'garden-journal-for-sharing');
  const exportedApp = path.join(exportedPackage, 'garden-journal.app');
  assert.equal(fs.existsSync(path.join(exportedApp, 'Contents', 'Resources', 'App', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(exportedApp, 'Contents', 'Resources', 'App', 'storage.json')), false);
  assert.match(fs.readFileSync(path.join(exportedPackage, 'README.txt'), 'utf8'), /not Apple Developer ID signed or notarized/);
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', exportedApp]).status, 0);
  assert.equal(fs.existsSync(app.path), true);

  responseContent = validResponse();
  responseContent.summary = 'Adds a way to mark garden plants as watered.';
  responseContent.files[0].content = responseContent.files[0].content.replace(
    '<button id="add">Add a plant</button>',
    '<button id="add">Add a plant</button><button id="water">Mark watered</button>',
  );
  const revision = await studio.reviseSavedProject(dataDirectory, project.slug, 'Add a way to mark plants as watered.');
  assert.equal(revision.projectSlug, project.slug);
  assert.match(lastModelRequest.messages[1].content, /Current app files:/);
  responseContent = validResponse();
  responseContent.files[0].content = responseContent.files[0].content.replace(
    '<button id="add">Add a plant</button>',
    '<button id="add">Add a plant</button><button id="water">Mark watered</button><button id="reset">Reset</button>',
  );
  const secondRevision = await studio.reviseProposal(revision.id, 'Also add a reset button.');
  assert.equal(secondRevision.projectSlug, project.slug);
  const updatedProject = studio.saveProject(dataDirectory, secondRevision.id);
  assert.equal(updatedProject.updated, true);
  const updatedMetadata = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'project.json'), 'utf8'));
  assert.equal(updatedMetadata.createdAt, originalCreatedAt);
  assert.match(fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8'), /Mark watered/);
  assert.equal((fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8').match(/class="app-copyright"/g) || []).length, 1);
  updatedProject.commit();
  const updatedApp = studio.installProject(
    { ...project, directory: projectDirectory },
    applicationsDirectory,
    path.join(__dirname, 'templates', 'AppShell.swift'),
    true,
  );
  assert.equal(updatedApp.updated, true);
  assert.match(fs.readFileSync(path.join(updatedApp.path, 'Contents', 'Resources', 'App', 'index.html'), 'utf8'), /Mark watered/);
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', updatedApp.path]).status, 0);
  const revisions = studio.listProjectRevisions(dataDirectory, project.slug);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0].summary, /mark plants as watered/i);
  const initialRevision = revisions[0];
  const restored = studio.restoreProjectRevision(dataDirectory, project.slug, initialRevision.id);
  assert.equal(restored.restored, true);
  assert.doesNotMatch(fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8'), /Reset/);
  assert.match(fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8'), /Mark watered/);
  assert.match(fs.readFileSync(path.join(updatedApp.path, 'Contents', 'Resources', 'App', 'index.html'), 'utf8'), /Mark watered/);
  assert.equal(studio.listProjectRevisions(dataDirectory, project.slug).length, 2);
  restored.rollback();
  assert.match(fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8'), /Reset/);
  assert.equal(studio.listProjectRevisions(dataDirectory, project.slug).length, 3);
  assert.throws(
    () => studio.restoreProjectRevision(dataDirectory, project.slug, '../outside'),
    { status: 400 },
  );

  assert.throws(() => studio.saveProject(dataDirectory, proposal.id), { status: 409 });
  assert.throws(() => studio.getSavedProjectPreview(dataDirectory, '../outside'), { status: 400 });
  assert.throws(() => studio.deleteProject(path.join(dataDirectory, 'other'), dataDirectory), /outside/);
});

test('refuses a model-generated draft that tries to load remote content', async () => {
  responseContent = validResponse();
  responseContent.files[0].content = responseContent.files[0].content.replace('</head>', '<img src="https://example.com/image.png"></head>');
  await assert.rejects(
    studio.createProposal('Unsafe Draft', 'Show a remote image.'),
    { status: 422, message: /safe local prototype/ },
  );
});

test('refuses generated browser storage that cannot be safely previewed', async () => {
  responseContent = validResponse();
  responseContent.files[2].content += '\nlocalStorage.setItem("plants", "[]");';
  await assert.rejects(
    studio.createProposal('Unsafe Storage', 'Save plant information.'),
    { status: 422, message: /safe local prototype/ },
  );
});

test('allows the private appStorage API for data that should persist in installed apps', async () => {
  responseContent = validResponse();
  responseContent.files[2].content += '\nwindow.appStorage.setItem("plants", JSON.stringify(["Fern"]));';
  responseContent.files[2].content += '\nfunction renderPlant(plant) { return plant; }';
  const proposal = await studio.createProposal('Persistent Plants', 'Remember the plant list.');
  assert.match(proposal.files[2].content, /window\.appStorage\.setItem/);
  assert.match(proposal.files[2].content, /function renderPlant/);
  assert.match(proposal.previewHtml, /window\.appStorage/);
});

test('still refuses the dynamic Function constructor', async () => {
  responseContent = validResponse();
  responseContent.files[2].content += '\nconst generated = Function("return 1")();';
  await assert.rejects(
    studio.createProposal('Unsafe Dynamic Code', 'Use generated code.'),
    { status: 422, message: /safe local prototype/ },
  );
});

test('normalizes named model file maps and removes an unsafe storage fallback', async () => {
  responseContent = validResponse();
  responseContent.files = Object.fromEntries(responseContent.files.map(({ path: filePath, content }) => [filePath, content]));
  responseContent.files['index.html'] = responseContent.files['index.html'].replace(' defer', '');
  responseContent.files['app.js'] = 'window.appStorage = window.appStorage || localStorage;\n'
    + responseContent.files['app.js'].replace(
      'document.querySelector("#add").addEventListener',
      'window.appStorage.setItem("plants", JSON.stringify([]));\ndocument.querySelector("#add").addEventListener',
    );
  const proposal = await studio.createProposal('Named File Map', 'Keep a plant list.');
  assert.deepEqual(proposal.files.map((file) => file.path), ['index.html', 'styles.css', 'app.js']);
  assert.match(proposal.files[0].content, /src="app\.js" defer/);
  assert.doesNotMatch(proposal.files[2].content, /localStorage/);
  assert.match(proposal.files[2].content, /window\.appStorage\.setItem/);
});

test('uses local screenshot understanding for app studio and Eddy suggestions', async () => {
  const screenshotBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('sample-jpeg')]);
  const screenshotBase64 = screenshotBytes.toString('base64');
  const screenshot = `data:image/jpeg;base64,${screenshotBase64}`;
  responseContent = validResponse();
  modelRequests.length = 0;
  unloadRequests.length = 0;
  runningModels = [{ name: 'qwen2.5-coder:3b' }];

  const appProposal = await studio.createProposal('Screenshot App', 'Make a simple notes app.', screenshot);
  assert.ok(appProposal.previewHtml);
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(unloadRequests, [{
    model: 'qwen2.5-coder:3b',
    prompt: '',
    keep_alive: 0,
    stream: false,
  }]);
  assert.deepEqual(modelRequests[0].messages[1].images, [screenshotBase64]);
  assert.equal(modelRequests[0].keep_alive, 0);
  assert.match(modelRequests[1].messages[1].content, /purple header and a rounded primary button/);

  const workspace = path.join(dataDirectory, 'coding-workspace');
  fs.mkdirSync(path.join(workspace, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'dist', 'index.html'), '<!doctype html><html><body><button id="save">Save</button></body></html>');
  const init = spawnSync('/usr/bin/git', ['init', '-q', workspace], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync('/usr/bin/git', ['add', 'dist/index.html'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync('/usr/bin/git', [
    '-c', 'user.name=LStore Test',
    '-c', 'user.email=lstore-test@example.invalid',
    'commit', '-qm', 'Initial fixture',
  ], { cwd: workspace, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);

  const codingAssistant = require('./coding-assistant');
  const codingProposal = await codingAssistant.createProposal(workspace, 'Make the Save button clearer.', screenshot);
  assert.match(codingProposal.diff, /Save changes/);
  const codingRequests = modelRequests.slice(2);
  assert.equal(codingRequests.length, 3);
  assert.deepEqual(codingRequests[0].messages[1].images, [screenshotBase64]);
  assert.match(codingRequests[1].messages[1].content, /purple header and a rounded primary button/);
  assert.match(codingRequests[2].messages[1].content, /purple header and a rounded primary button/);
});

test('rejects invalid and oversized local screenshot payloads', () => {
  const localVision = require('./local-vision');
  assert.throws(() => localVision.validateImage('https://example.com/image.png'), { status: 400 });
  assert.throws(() => localVision.validateImage('data:image/jpeg;base64,AQIDBA=='), { status: 400 });
  const oversizedPng = Buffer.alloc(3 * 1024 * 1024 + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng);
  assert.throws(() => localVision.validateImage(`data:image/png;base64,${oversizedPng.toString('base64')}`), { status: 413 });
});

test('persists appStorage data across a WebKit store restart', () => {
  const executable = path.join(dataDirectory, 'app-storage-bridge-test');
  const supportDirectory = path.join(dataDirectory, 'native-app-support');
  const compile = spawnSync('/usr/bin/swiftc', [
    '-D', 'LSTORE_STORAGE_TEST',
    '-framework', 'AppKit',
    '-framework', 'Foundation',
    '-framework', 'WebKit',
    '-o', executable,
    path.join(__dirname, 'templates', 'AppShell.swift'),
    path.join(__dirname, 'tests', 'AppStorageBridgeTest.swift'),
  ], { encoding: 'utf8', timeout: 120000 });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);

  const write = spawnSync(executable, [supportDirectory, 'write'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(write.status, 0, write.stderr || write.error?.message);
  assert.match(write.stdout, /WebKit appStorage bridge writes app data/);
  assert.match(write.stdout, /private file permissions/);
  assert.match(write.stdout, /size-limit protections work/);

  const reopen = spawnSync(executable, [supportDirectory, 'reopen'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(reopen.status, 0, reopen.stderr || reopen.error?.message);
  assert.match(reopen.stdout, /after quitting and reopening the app process/);
});

function validResponse() {
  return {
    summary: 'A simple garden plant tracker.',
    files: [
      {
        path: 'index.html',
        content: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Garden Journal</title><link rel="stylesheet" href="styles.css"><script src="app.js" defer></script></head><body><main><h1>Garden Journal</h1><button id="add">Add a plant</button><ul id="plants"></ul></main></body></html>',
      },
      {
        path: 'styles.css',
        content: 'body { font-family: sans-serif; }',
      },
      {
        path: 'app.js',
        content: 'document.querySelector("#add").addEventListener("click", () => { const item = document.createElement("li"); item.textContent = "New plant"; document.querySelector("#plants").append(item); });',
      },
    ],
  };
}
