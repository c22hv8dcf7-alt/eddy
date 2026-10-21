const appList = document.getElementById('app-list');
const featuredApp = document.getElementById('featured-app');
const appSelect = document.getElementById('release-app-id');
const createAppForm = document.getElementById('create-app-form');
const releaseForm = document.getElementById('release-form');
const adminForm = document.getElementById('admin-form');
const adminTokenInput = document.getElementById('admin-token');
const adminStatus = document.getElementById('admin-status');
const codingForm = document.getElementById('coding-form');
const codingRequest = document.getElementById('coding-request');
const codingStatus = document.getElementById('coding-status');
const codingSubmit = document.getElementById('coding-submit');
const codingResult = document.getElementById('coding-result');
const codingSummary = document.getElementById('coding-summary');
const codingFiles = document.getElementById('coding-files');
const codingExisting = document.getElementById('coding-existing');
const codingDiff = document.getElementById('coding-diff');
const codingPublish = document.getElementById('coding-publish');
const codingBuildOutput = document.getElementById('coding-build-output');
const codingBuildDetails = document.getElementById('coding-build-details');
const codingPreview = document.getElementById('coding-preview');
const codingScreenshot = document.getElementById('coding-screenshot');
const codingScreenshotStatus = document.getElementById('coding-screenshot-status');
const codingScreenshotPreview = document.getElementById('coding-screenshot-preview');
const codingReferenceImage = document.getElementById('coding-reference-image');
const studioForm = document.getElementById('studio-form');
const studioName = document.getElementById('studio-name');
const studioIdea = document.getElementById('studio-idea');
const studioStatus = document.getElementById('studio-status');
const studioSubmit = document.getElementById('studio-submit');
const studioResult = document.getElementById('studio-result');
const studioSummary = document.getElementById('studio-summary');
const studioDraftName = document.getElementById('studio-draft-name');
const studioPreview = document.getElementById('studio-preview');
const studioReviseForm = document.getElementById('studio-revise-form');
const studioRevision = document.getElementById('studio-revision');
const studioRevise = document.getElementById('studio-revise');
const studioFiles = document.getElementById('studio-files');
const studioCreate = document.getElementById('studio-create');
const studioSaveNote = document.getElementById('studio-save-note');
const studioProjectList = document.getElementById('studio-project-list');
const studioProjectChangeForm = document.getElementById('studio-project-change-form');
const studioProjectSelect = document.getElementById('studio-project-select');
const studioProjectInstruction = document.getElementById('studio-project-instruction');
const studioProjectChange = document.getElementById('studio-project-change');
const studioProjectHelp = document.getElementById('studio-project-help');
const studioTestDialog = document.getElementById('studio-test-dialog');
const studioTestTitle = document.getElementById('studio-test-title');
const studioTestFrame = document.getElementById('studio-test-frame');
const studioTestClose = document.getElementById('studio-test-close');
const studioScreenshot = document.getElementById('studio-screenshot');
const studioScreenshotStatus = document.getElementById('studio-screenshot-status');
const studioScreenshotPreview = document.getElementById('studio-screenshot-preview');
const studioReferenceImage = document.getElementById('studio-reference-image');
const studioRevisionScreenshot = document.getElementById('studio-revision-screenshot');
const studioRevisionScreenshotStatus = document.getElementById('studio-revision-screenshot-status');
const studioRevisionScreenshotPreview = document.getElementById('studio-revision-screenshot-preview');
const studioProjectScreenshot = document.getElementById('studio-project-screenshot');
const studioProjectScreenshotStatus = document.getElementById('studio-project-screenshot-status');
const studioProjectScreenshotPreview = document.getElementById('studio-project-screenshot-preview');

let adminToken = sessionStorage.getItem('lstore-admin-token') || '';
let currentProposalId = '';
let currentStudioProposalId = '';
let currentStudioScreenshot = '';
const screenshotJobs = new WeakMap();
adminTokenInput.value = adminToken;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function createScreenshotData(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      reject(new Error('Choose a PNG, JPEG, or WebP screenshot.'));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error('Choose a screenshot smaller than 20 MB.'));
      return;
    }
    createImageBitmap(file).then((bitmap) => {
      try {
        if (bitmap.width * bitmap.height > 40_000_000) {
          throw new Error('That image is too large to safely resize. Choose a smaller screenshot.');
        }
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('This screenshot could not be processed on this Mac.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL('image/jpeg', 0.82);
        const base64 = image.slice(image.indexOf(',') + 1);
        if (Math.ceil(base64.length * 0.75) > 3 * 1024 * 1024) {
          throw new Error('This screenshot is still too large after resizing. Choose a smaller image.');
        }
        resolve(image);
      } catch (error) {
        reject(error);
      } finally {
        bitmap.close();
      }
    }).catch(() => reject(new Error('This screenshot could not be opened. Choose another image.')));
  });
}

function bindScreenshotInput(input, preview, status, defaultMessage) {
  input.addEventListener('change', () => {
    preview.hidden = true;
    if (!input.files?.length) {
      screenshotJobs.delete(input);
      status.textContent = defaultMessage;
      return;
    }
    const job = createScreenshotData(input.files[0]);
    screenshotJobs.set(input, job);
    status.textContent = 'Resizing the screenshot on this Mac…';
    job.then((image) => {
      preview.src = image;
      preview.hidden = false;
      status.textContent = 'Ready. This image will be interpreted locally and is not saved with the app.';
    }).catch((error) => {
      screenshotJobs.delete(input);
      status.textContent = error.message;
    });
  });
}

async function getScreenshot(input) {
  if (!input.files?.length) return '';
  let job = screenshotJobs.get(input);
  if (!job) {
    job = createScreenshotData(input.files[0]);
    screenshotJobs.set(input, job);
  }
  return job;
}

function setReferenceImage(imageElement, imageData) {
  imageElement.src = imageData || '';
  imageElement.hidden = !imageData;
}

bindScreenshotInput(
  studioScreenshot,
  studioScreenshotPreview,
  studioScreenshotStatus,
  'The image is resized and analyzed on this Mac; it is not saved with your app.',
);
bindScreenshotInput(
  studioRevisionScreenshot,
  studioRevisionScreenshotPreview,
  studioRevisionScreenshotStatus,
  'Processed only on this Mac.',
);
bindScreenshotInput(
  studioProjectScreenshot,
  studioProjectScreenshotPreview,
  studioProjectScreenshotStatus,
  'Processed only on this Mac.',
);
bindScreenshotInput(
  codingScreenshot,
  codingScreenshotPreview,
  codingScreenshotStatus,
  'The local vision model reads it on this Mac. The image is not included in the Eddy update.',
);

function buildVisualPreview(preview) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 760 328');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Illustrative preview of ${preview.screen}: ${preview.before} changing to ${preview.after}`);

  function shape(name, attributes, parent = svg) {
    const element = document.createElementNS(namespace, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    parent.appendChild(element);
    return element;
  }

  function text(value, x, y, options = {}) {
    const element = shape('text', {
      x, y,
      fill: options.fill || '#1e293b',
      'font-size': options.size || 14,
      'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
      'font-weight': options.weight || 400,
      'text-anchor': options.anchor || 'start',
    });
    element.textContent = String(value || '').slice(0, 70);
    return element;
  }

  shape('rect', { x: 0, y: 0, width: 760, height: 328, rx: 16, fill: '#e8edf5' });
  const cards = [
    { x: 16, label: 'BEFORE', value: preview.before, tint: '#ffffff' },
    { x: 388, label: 'AFTER YOUR CHANGE', value: preview.after, tint: '#f1ebff' },
  ];
  cards.forEach((card, index) => {
    shape('rect', { x: card.x, y: 16, width: 356, height: 296, rx: 14, fill: card.tint });
    shape('circle', { cx: card.x + 26, cy: 43, r: 11, fill: '#7c3aed' });
    text('E', card.x + 26, 47, { fill: '#ffffff', size: 10, weight: 700, anchor: 'middle' });
    text(preview.screen || 'Eddy', card.x + 46, 48, { size: 16, weight: 700 });
    text(card.label, card.x + 18, 82, { fill: index ? '#6d28d9' : '#64748b', size: 10, weight: 700 });
    shape('rect', { x: card.x + 16, y: 96, width: 324, height: 194, rx: 10, fill: '#f8fafc', stroke: '#dbe2ec' });
    text(preview.element || 'Screen change', card.x + 30, 127, { fill: '#64748b', size: 11, weight: 600 });
    shape('rect', { x: card.x + 30, y: 144, width: 296, height: 58, rx: 10, fill: index ? '#ede9fe' : '#e9eef5' });
    const value = String(card.value || '').slice(0, 78);
    const firstLine = value.length > 36 ? `${value.slice(0, 35)}…` : value;
    const secondLine = value.length > 36 ? value.slice(35, 70) : '';
    text(firstLine || 'No text preview', card.x + 44, 169, { fill: '#334155', size: 13, weight: 600 });
    if (secondLine) text(secondLine, card.x + 44, 187, { fill: '#334155', size: 12 });
    shape('rect', { x: card.x + 30, y: 220, width: 136, height: 38, rx: 9, fill: index ? '#6d28d9' : '#64748b' });
    text(index ? 'Updated' : 'Current', card.x + 98, 244, { fill: '#ffffff', size: 12, weight: 700, anchor: 'middle' });
  });

  codingPreview.replaceChildren(svg);
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

async function loadApps() {
  try {
    const apps = await readResponse(await fetch('/api/apps'));
    appList.innerHTML = '';
    featuredApp.innerHTML = '';
    appSelect.innerHTML = '<option value="">Select app</option>';

    if (!apps.length) {
      featuredApp.innerHTML = '<div class="empty-state">No apps are available yet.</div>';
      appList.innerHTML = '';
      return;
    }

    apps.forEach((app) => {
      const latest = app.latestRelease;
      const releases = (app.releases || [])
        .slice(0, 5)
        .map((release) => `<li><strong>${escapeHtml(release.version)}</strong> — ${escapeHtml(release.notes || 'No notes provided')}</li>`)
        .join('');

      if (app.slug === 'eddy') {
        const featured = document.createElement('article');
        featured.className = 'featured-card';
        featured.innerHTML = `
          <div class="featured-art" aria-hidden="true">
            <div class="featured-glow"></div>
            <div class="featured-icon">E</div>
            <span class="art-spark spark-one">✦</span>
            <span class="art-spark spark-two">✧</span>
          </div>
          <div class="featured-details">
            <div class="featured-title-row">
              <div>
                <span class="tag stable">${latest ? 'Ready to download' : 'Coming soon'}</span>
                <h3>${escapeHtml(app.name)}</h3>
                <p class="featured-subtitle">A little life, beautifully counted.</p>
              </div>
              <div class="featured-version">${latest ? `Version ${escapeHtml(latest.version)}` : 'No release yet'}</div>
            </div>
            <p class="featured-notes">${escapeHtml(latest?.notes || 'Your personal space to explore, collect, and care for the small lives around you.')}</p>
            <div class="featured-actions">
              ${latest?.installerUrl
                ? `<a class="download-button" href="${escapeHtml(latest.installerUrl)}">Download</a>`
                : '<span class="download-button disabled">Not available yet</span>'}
              <span class="download-caption">For Mac · Apple silicon</span>
            </div>
          </div>
        `;
        featuredApp.appendChild(featured);
      }

      if (!app.localProject || latest) {
        const card = document.createElement('article');
        card.className = 'app-card';
        card.innerHTML = `
          <div class="app-header">
            <div>
              <h3>${escapeHtml(app.name)}</h3>
              <p class="history-caption">${latest ? `Latest version ${escapeHtml(latest.version)}` : 'No release yet'}</p>
            </div>
            <span class="tag stable">${latest ? 'stable' : 'no release'}</span>
          </div>
          <ul class="release-list">${releases || '<li>No releases published yet.</li>'}</ul>
          <details class="feed-details">
            <summary>Updater address</summary>
            <div class="endpoint">${escapeHtml(app.updateUrl)}</div>
          </details>
        `;

        appList.appendChild(card);
      }
      const option = document.createElement('option');
      option.value = app.slug;
      option.textContent = app.name;
      appSelect.appendChild(option);
    });
    if (!appList.childElementCount) {
      appList.innerHTML = '<div class="empty-state">No apps have been published yet. Saved drafts are under Your app projects.</div>';
    }
    if (!featuredApp.childElementCount) {
      featuredApp.innerHTML = '<div class="empty-state">Eddy is not available in the store yet.</div>';
    }
  } catch (error) {
    featuredApp.textContent = error.message;
    appList.textContent = '';
  }
}

async function loadCodingStatus() {
  try {
    const status = await readResponse(await fetch('/api/coding/status'));
    const screenshotStatus = status.screenshotModelAvailable
      ? `Screenshot understanding is ready locally (${status.screenshotModel}).`
      : `Screenshot understanding needs the local Ollama model ${status.screenshotModel}; text-only suggestions still work.`;
    [codingScreenshotStatus, studioScreenshotStatus, studioRevisionScreenshotStatus, studioProjectScreenshotStatus]
      .forEach((element) => {
        if (!element.previousElementSibling?.files?.length) element.textContent = screenshotStatus;
      });
    if (!status.ollamaAvailable) {
      codingStatus.textContent = 'Open Ollama to start the local model.';
      studioStatus.textContent = 'Open Ollama to start the local model.';
      return;
    }
    if (!status.modelAvailable) {
      codingStatus.textContent = `Local model not found: ${status.model}`;
      studioStatus.textContent = `Local model not found: ${status.model}`;
      return;
    }
    studioStatus.textContent = 'Local AI is ready';
    studioStatus.classList.add('ready');
    studioSubmit.disabled = false;
    if (!status.workspaceAvailable) {
      codingStatus.textContent = 'Eddy project folder could not be found.';
      return;
    }
    codingStatus.textContent = 'Ready — works on this Mac';
    codingStatus.classList.add('ready');
    codingSubmit.disabled = false;
  } catch (error) {
    codingStatus.textContent = error.message;
    studioStatus.textContent = error.message;
  }
}

studioProjectChangeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const slug = studioProjectSelect.value;
  if (!slug) return;
  const appName = studioProjectSelect.selectedOptions[0]?.textContent || 'your app';
  studioProjectChange.disabled = true;
  studioSubmit.disabled = true;
  studioStatus.textContent = `Preparing a reviewed change to ${appName}…`;
  try {
    const screenshot = await getScreenshot(studioProjectScreenshot);
    const proposal = await readResponse(await fetch(
      `/api/studio/projects/${encodeURIComponent(slug)}/revisions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: studioProjectInstruction.value, screenshot }),
      },
    ));
    currentStudioProposalId = proposal.id;
    currentStudioScreenshot = screenshot;
    displayStudioProposal(proposal);
    studioResult.hidden = false;
    studioCreate.disabled = false;
    studioRevise.disabled = false;
    studioProjectInstruction.value = '';
    studioStatus.textContent = 'Change ready. Try it and review the files before saving.';
    studioStatus.classList.add('ready');
    studioResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    studioStatus.textContent = error.message;
  } finally {
    studioProjectChange.disabled = false;
    studioSubmit.disabled = false;
  }
});

studioForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  currentStudioProposalId = '';
  currentStudioScreenshot = '';
  studioResult.hidden = true;
  studioSubmit.disabled = true;
  studioStatus.textContent = 'Creating a draft with the local AI. This can take a minute…';

  try {
    const screenshot = await getScreenshot(studioScreenshot);
    const proposal = await readResponse(await fetch('/api/studio/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: studioName.value, idea: studioIdea.value, screenshot }),
    }));
    currentStudioProposalId = proposal.id;
    currentStudioScreenshot = screenshot;
    displayStudioProposal(proposal);
    studioResult.hidden = false;
    studioStatus.textContent = 'Draft ready. Try it, then ask for changes or save it.';
    studioStatus.classList.add('ready');
    studioCreate.disabled = false;
  } catch (error) {
    studioStatus.textContent = error.message;
  } finally {
    studioSubmit.disabled = false;
  }
});

studioReviseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentStudioProposalId) return;
  studioRevise.disabled = true;
  studioCreate.disabled = true;
  studioSubmit.disabled = true;
  studioStatus.textContent = 'Making your requested change with the local AI…';
  try {
    const screenshot = await getScreenshot(studioRevisionScreenshot);
    const proposal = await readResponse(await fetch(
      `/api/studio/proposals/${encodeURIComponent(currentStudioProposalId)}/revise`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: studioRevision.value, screenshot }),
      },
    ));
    currentStudioProposalId = proposal.id;
    if (screenshot) currentStudioScreenshot = screenshot;
    displayStudioProposal(proposal);
    studioRevision.value = '';
    studioStatus.textContent = 'Updated draft ready. Try it and review the files again.';
    studioStatus.classList.add('ready');
  } catch (error) {
    studioStatus.textContent = error.message;
  } finally {
    studioRevise.disabled = false;
    studioCreate.disabled = false;
    studioSubmit.disabled = false;
  }
});

function displayStudioProposal(proposal) {
  studioSummary.textContent = proposal.summary;
  studioDraftName.textContent = proposal.name;
  studioCreate.textContent = proposal.projectSlug
    ? `Save changes to ${proposal.name}`
    : '2. Save draft to LStore';
  studioSaveNote.textContent = proposal.projectSlug
    ? 'The saved app stays unchanged until you choose this.'
    : 'After saving, you can install it whenever you choose.';
  studioPreview.srcdoc = proposal.previewHtml;
  setReferenceImage(studioReferenceImage, currentStudioScreenshot);
  studioFiles.replaceChildren();
  proposal.files.forEach((file) => {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const code = document.createElement('pre');
    details.className = 'studio-file';
    summary.textContent = file.path;
    code.className = 'coding-diff';
    code.textContent = file.content;
    details.append(summary, code);
    studioFiles.append(details);
  });
}

studioTestClose.addEventListener('click', () => {
  studioTestDialog.close();
  studioTestFrame.srcdoc = '';
});
studioTestDialog.addEventListener('close', () => {
  studioTestFrame.srcdoc = '';
});

studioCreate.addEventListener('click', async () => {
  if (!currentStudioProposalId
      || !window.confirm('Save this reviewed draft in LStore? It will not be installed yet.')) {
    return;
  }

  studioCreate.disabled = true;
  studioStatus.textContent = 'Saving your app project on this Mac…';
  try {
    const project = await readResponse(await fetch(
      `/api/studio/proposals/${encodeURIComponent(currentStudioProposalId)}/create`,
      { method: 'POST' },
    ));
    currentStudioProposalId = '';
    studioResult.hidden = true;
    studioForm.reset();
    [studioScreenshot, studioRevisionScreenshot, studioProjectScreenshot].forEach((input) => {
      input.value = '';
    });
    [studioScreenshotPreview, studioRevisionScreenshotPreview, studioProjectScreenshotPreview]
      .forEach((preview) => {
        preview.removeAttribute('src');
        preview.hidden = true;
      });
    currentStudioScreenshot = '';
    studioStatus.textContent = project.message;
    studioStatus.classList.add('ready');
    await Promise.all([loadStudioProjects(), loadApps()]);
  } catch (error) {
    studioStatus.textContent = error.message;
    studioCreate.disabled = false;
  }
});

async function loadStudioProjects() {
  try {
    const projects = await readResponse(await fetch('/api/studio/projects'));
    const selectedSlug = studioProjectSelect.value;
    studioProjectSelect.replaceChildren(new Option(
      projects.length ? 'Choose a saved app' : 'No saved apps yet',
      '',
    ));
    projects.forEach((project) => {
      studioProjectSelect.add(new Option(project.name, project.slug));
    });
    studioProjectSelect.value = projects.some((project) => project.slug === selectedSlug) ? selectedSlug : '';
    studioProjectSelect.disabled = projects.length === 0;
    studioProjectInstruction.disabled = projects.length === 0;
    studioProjectChange.disabled = projects.length === 0;
    studioProjectHelp.textContent = projects.length
      ? 'Your saved app will stay unchanged until you review and save the suggested changes.'
      : 'Create a draft above and choose “Save draft to LStore.” It will then appear here to select.';
    studioProjectList.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No app projects yet.';
      studioProjectList.append(empty);
      return;
    }
    projects.forEach((project) => {
      const card = document.createElement('article');
      const heading = document.createElement('h4');
      const description = document.createElement('p');
      const status = document.createElement('span');
      card.className = 'studio-project';
      heading.textContent = project.name;
      description.textContent = project.summary;
      status.className = 'history-caption';
      status.textContent = project.installed
        ? 'Saved in LStore · Installed copy may need updating'
        : 'Saved in LStore · Not installed';
      card.append(heading, description, status);
      if (project.revisions?.length) {
        const revisionLabel = document.createElement('label');
        revisionLabel.className = 'project-revision-label';
        revisionLabel.textContent = 'Previous saved versions';
        const revisionSelect = document.createElement('select');
        project.revisions.forEach((revision, index) => {
          const savedDate = revision.savedAt ? new Date(revision.savedAt).toLocaleString() : 'Earlier version';
          const option = new Option(`${savedDate} — ${revision.summary}`, revision.id);
          if (index === 0) option.selected = true;
          revisionSelect.add(option);
        });
        revisionLabel.append(revisionSelect);
        const restoreButton = document.createElement('button');
        restoreButton.type = 'button';
        restoreButton.className = 'secondary-button';
        restoreButton.textContent = 'Restore selected version';
        restoreButton.addEventListener('click', async () => {
          const selected = project.revisions.find((revision) => revision.id === revisionSelect.value);
          if (!selected || !window.confirm(`Restore the selected earlier version of ${project.name}? The current version will be kept in history. The installed app will not change until you update it.`)) return;
          restoreButton.disabled = true;
          studioStatus.textContent = `Restoring ${project.name}…`;
          try {
            const restored = await readResponse(await fetch(
              `/api/studio/projects/${encodeURIComponent(project.slug)}/revisions/${encodeURIComponent(selected.id)}/restore`,
              { method: 'POST' },
            ));
            studioStatus.textContent = restored.message;
            await loadStudioProjects();
          } catch (error) {
            studioStatus.textContent = error.message;
            restoreButton.disabled = false;
          }
        });
        card.append(revisionLabel, restoreButton);
      }
      const tryButton = document.createElement('button');
      tryButton.type = 'button';
      tryButton.className = 'secondary-button';
      tryButton.textContent = 'Try app';
      tryButton.addEventListener('click', async () => {
        tryButton.disabled = true;
        try {
          const response = await fetch(`/api/studio/projects/${encodeURIComponent(project.slug)}/preview`);
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Could not open preview (${response.status}).`);
          }
          studioTestTitle.textContent = `Try ${project.name}`;
          studioTestFrame.srcdoc = await response.text();
          studioTestDialog.showModal();
        } catch (error) {
          studioStatus.textContent = error.message;
        } finally {
          tryButton.disabled = false;
        }
      });
      card.append(tryButton);
      const installButton = document.createElement('button');
      installButton.type = 'button';
      installButton.textContent = project.installed ? 'Update installed app' : 'Install in Applications';
      installButton.addEventListener('click', async () => {
        const confirmation = project.installed
          ? `Replace the installed ${project.name} with the version saved in LStore? Quit and reopen it afterward to see the changes.`
          : `Build and install ${project.name} in your personal Applications folder?`;
        if (!window.confirm(confirmation)) return;
        installButton.disabled = true;
        studioStatus.textContent = project.installed
          ? `Updating ${project.name} in Applications…`
          : `Building ${project.name}…`;
        try {
          const installed = await readResponse(await fetch(
            `/api/studio/projects/${encodeURIComponent(project.slug)}/install`,
            { method: 'POST' },
          ));
          studioStatus.textContent = installed.message;
          await loadStudioProjects();
        } catch (error) {
          studioStatus.textContent = error.message;
          installButton.disabled = false;
        }
      });
      card.append(installButton);
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'secondary-button';
      exportButton.textContent = 'Prepare copy to share';
      exportButton.addEventListener('click', async () => {
        const confirmation = `Prepare a shareable copy of ${project.name} in Downloads? It will not be sent or uploaded. The zip will not include your saved app data. It is locally signed, not notarized, so macOS may show a security warning.`;
        if (!window.confirm(confirmation)) return;
        exportButton.disabled = true;
        studioStatus.textContent = `Preparing a copy of ${project.name}…`;
        try {
          const exported = await readResponse(await fetch(
            `/api/studio/projects/${encodeURIComponent(project.slug)}/export`,
            { method: 'POST' },
          ));
          studioStatus.textContent = exported.message;
        } catch (error) {
          studioStatus.textContent = error.message;
        } finally {
          exportButton.disabled = false;
        }
      });
      card.append(exportButton);
      studioProjectList.append(card);
    });
  } catch (error) {
    studioProjectList.textContent = error.message;
  }
}

codingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  currentProposalId = '';
  codingResult.hidden = true;
  codingSubmit.disabled = true;
  codingStatus.textContent = 'Making your suggestion. This can take a minute…';

  try {
    const screenshot = await getScreenshot(codingScreenshot);
    const proposal = await readResponse(await fetch('/api/coding/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: codingRequest.value, screenshot }),
    }));
    currentProposalId = proposal.id;
    codingSummary.textContent = proposal.summary;
    codingFiles.textContent = `Files to change: ${proposal.files.join(', ')}`;
    buildVisualPreview(proposal.preview);
    setReferenceImage(codingReferenceImage, screenshot);
    codingExisting.hidden = proposal.changedFiles === 0;
    codingExisting.textContent = proposal.changedFiles
      ? 'Some files already have changes. LStore checks that the files in this suggestion have not changed before applying it.'
      : '';
    codingDiff.textContent = proposal.diff;
    codingBuildOutput.hidden = true;
    codingBuildDetails.hidden = true;
    codingResult.hidden = false;
    codingPublish.disabled = false;
    codingStatus.textContent = 'Step 2: Read the suggestion before continuing.';
    codingStatus.classList.add('ready');
  } catch (error) {
    codingStatus.textContent = error.message;
  } finally {
    codingSubmit.disabled = false;
  }
});

codingPublish.addEventListener('click', async () => {
  if (!currentProposalId || !window.confirm('Apply this reviewed suggestion, build Eddy, sign it, and publish the new version to LStore?')) {
    return;
  }
  codingPublish.disabled = true;
  codingBuildOutput.hidden = false;
  codingBuildOutput.textContent = 'Starting the local Eddy build…';
  codingBuildDetails.hidden = false;
  codingBuildDetails.open = false;
  codingStatus.textContent = 'Building your Eddy update. Keep LStore open; this may take several minutes…';
  try {
    const job = await readResponse(await fetch(`/api/coding/proposals/${encodeURIComponent(currentProposalId)}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: codingSummary.textContent }),
    }));
    codingBuildOutput.textContent = `Building Eddy ${job.version}…\n`;
    codingStatus.textContent = `Building Eddy ${job.version}. Keep LStore open; this may take several minutes…`;
    await pollCodingJob(job.id);
  } catch (error) {
    codingStatus.textContent = error.message;
    codingPublish.disabled = false;
  }
});

async function pollCodingJob(jobId) {
  try {
    const job = await readResponse(await fetch(`/api/coding/jobs/${encodeURIComponent(jobId)}`));
    codingBuildOutput.textContent = job.output;
    codingBuildOutput.scrollTop = codingBuildOutput.scrollHeight;
    if (job.status === 'building') {
      window.setTimeout(() => pollCodingJob(jobId), 1500);
      return;
    }
    currentProposalId = '';
    codingPublish.disabled = job.status !== 'complete';
    codingStatus.textContent = job.message;
    if (job.status === 'complete') {
      codingResult.hidden = true;
      loadApps();
    } else {
      codingBuildDetails.open = true;
      codingBuildOutput.textContent += `\n${job.message}`;
    }
  } catch (error) {
    codingStatus.textContent = `Could not check build progress: ${error.message}`;
    codingPublish.disabled = false;
  }
}

adminForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = adminTokenInput.value.trim();
  try {
    await readResponse(await fetch('/api/admin/check', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    adminToken = token;
    sessionStorage.setItem('lstore-admin-token', token);
    adminStatus.textContent = 'Unlocked';
    adminStatus.classList.add('unlocked');
  } catch (error) {
    adminToken = '';
    sessionStorage.removeItem('lstore-admin-token');
    adminStatus.textContent = error.message;
    adminStatus.classList.remove('unlocked');
  }
});

createAppForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const formData = new FormData(createAppForm);
    const data = await readResponse(await fetch('/api/apps', {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appName: formData.get('appName'),
        slug: formData.get('slug'),
      }),
    }));

    alert(`App created: ${data.name}`);
    createAppForm.reset();
    await loadApps();
  } catch (error) {
    alert(error.message);
  }
});

releaseForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const formData = new FormData(releaseForm);
    if (!formData.get('appId')) {
      throw new Error('Select the app you want to update.');
    }
    formData.set('platform', 'darwin-aarch64');

    const data = await readResponse(await fetch('/api/releases', {
      method: 'POST',
      headers: adminHeaders(),
      body: formData,
    }));

    alert(`Version ${data.release.version} uploaded successfully.`);
    releaseForm.reset();
    await loadApps();
  } catch (error) {
    alert(error.message);
  }
});

if (adminToken) {
  fetch('/api/admin/check', { headers: adminHeaders() })
    .then((response) => {
      if (!response.ok) throw new Error('Locked');
      adminStatus.textContent = 'Unlocked';
      adminStatus.classList.add('unlocked');
    })
    .catch(() => {
      sessionStorage.removeItem('lstore-admin-token');
      adminToken = '';
      adminTokenInput.value = '';
    });
}

loadApps();
loadStudioProjects();
loadCodingStatus();
