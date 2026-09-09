'use strict';

(() => {
  const shell = document.getElementById('editorShell');
  const sidebar = document.querySelector('.sidebar');
  const inspector = document.getElementById('contextInspector');
  const inspectorContent = document.getElementById('inspectorContent');
  if (!shell || !sidebar || !inspector || !inspectorContent) return;

  const headingPanels = {
    sectionPreset: 'media',
    sectionAspect: 'style',
    sectionPosition: 'style',
    sectionFrame: 'style',
    sectionStatusBar: 'style',
    sectionTap: 'clicks',
    sectionBackground: 'style',
    sectionVideoFrame: 'style',
    sectionCrop: 'style',
    sectionZoomDefaults: 'clicks',
    sectionAnnotations: 'annotations',
  };

  let panel = 'media';
  for (const child of [...sidebar.children]) {
    if (child.classList.contains('sidebar-shell-head') || child.hasAttribute('data-editor-panel')) continue;
    if (headingPanels[child.id]) panel = headingPanels[child.id];
    child.dataset.editorPanel = child.id === 'imgExportSec' ? 'export' : panel;
  }

  const moveControl = (id, slotId) => {
    const control = document.getElementById(id);
    const slot = document.getElementById(slotId);
    if (control && slot) slot.appendChild(control);
    return control;
  };

  const mic = moveControl('micSel', 'audioDeviceSlot');
  const meter = document.querySelector('.level-meter');
  if (meter) document.getElementById('audioDeviceSlot').appendChild(meter);
  const camera = moveControl('camSel', 'cameraDeviceSlot');
  const cameraToggle = moveControl('camToggle', 'cameraDeviceSlot');
  const exportPreset = moveControl('videoExportPreset', 'exportPresetSlot');
  if (mic) mic.classList.add('shell-device-select');
  if (camera) camera.classList.add('shell-device-select');
  if (cameraToggle) cameraToggle.classList.add('shell-camera-toggle');
  if (exportPreset) exportPreset.classList.add('shell-export-preset');

  const settingsSlot = document.getElementById('settingsSlot');
  for (const id of ['langSel', 'themeBtn', 'shortcutBtn', 'diagBtn']) {
    const control = document.getElementById(id);
    if (control) settingsSlot.appendChild(control);
  }

  for (const id of ['cameraEdit', 'voiceEdit', 'segEdit', 'markerEdit', 'annotationEdit']) {
    const panelElement = document.getElementById(id);
    if (panelElement) inspectorContent.appendChild(panelElement);
  }

  const labels = {
    th: {
      media: 'สื่อในโปรเจกต์', record: 'อัดหน้าจอ', audio: 'เสียง', camera: 'กล้อง', clicks: 'Click & Zoom', annotations: 'มาร์กอัป', style: 'สไตล์', export: 'ส่งออก', settings: 'ตั้งค่า',
      railMedia: 'สื่อ', railRecord: 'อัด', railAudio: 'เสียง', railCamera: 'กล้อง', railClicks: 'คลิก', railAnnotations: 'มาร์กอัป', railStyle: 'สไตล์', railExport: 'ส่งออก', railSettings: 'ตั้งค่า',
      inspectorEmptyTitle: 'เลือกสิ่งที่ต้องการแก้ไข', inspectorEmptyBody: 'เลือกวิดีโอ เสียง กล้อง หรือจุดซูมบน timeline เพื่อดูคุณสมบัติ',
      inspectorNone: 'ยังไม่ได้เลือกคลิป', inspectorVideo: 'วิดีโอ', inspectorVoice: 'เสียงบรรยาย', inspectorCamera: 'กล้องผู้บรรยาย', inspectorZoom: 'จุดซูม',
      addMedia: 'เพิ่มไฟล์', recordMedia: 'อัดหน้าจอ', voiceMedia: 'พากย์เสียง', startVoice: 'เริ่มพากย์เสียง', exportVideo: 'Export วิดีโอ', snapshot: 'บันทึกเฟรม PNG',
      recordTitle: 'เริ่มอัดหน้าจอ', recordBody: 'เลือกหน้าต่าง จอ iPhone หรือ Android แล้วเริ่มอัดจากที่เดียว', recordStart: 'เลือกสิ่งที่จะอัด', diagnostics: 'ตรวจความพร้อมระบบ',
      audioTitle: 'เสียงบรรยาย', audioBody: 'เลือกไมโครโฟนก่อนเริ่มพากย์จากตำแหน่ง playhead', cameraTitle: 'กล้องผู้บรรยาย', cameraBody: 'กล้องจะถูกอัดเป็นคลิปแยกและแก้ตำแหน่งภายหลังได้',
      exportTitle: 'ตั้งค่าการส่งออก', exportBody: 'เลือกความละเอียดก่อนเปิดหน้าต่าง Export', settingsTitle: 'แอปและโปรเจกต์', settingsBody: 'ภาษา ธีม คีย์ลัด และเครื่องมือตรวจสอบ',
      advanced: 'ขั้นสูง', advancedBody: 'การตั้งค่า cursor, shortcut และ annotation พร้อมสำหรับโปรเจกต์รุ่นถัดไป โดยยังไม่เปลี่ยนพฤติกรรมการเรนเดอร์เดิม',
      annotationsTitle: 'มาร์กอัปบนวิดีโอ', annotationsBody: 'เลือกเครื่องมือแล้วลากบนตัวอย่าง เพื่อเพิ่มข้อความ ลูกศร กรอบ ไฮไลต์ หรือเบลอ',
    },
    en: {
      media: 'Project media', record: 'Record', audio: 'Audio', camera: 'Camera', clicks: 'Click & Zoom', annotations: 'Annotations', style: 'Style', export: 'Export', settings: 'Settings',
      railMedia: 'Media', railRecord: 'Record', railAudio: 'Audio', railCamera: 'Camera', railClicks: 'Clicks', railAnnotations: 'Annotate', railStyle: 'Style', railExport: 'Export', railSettings: 'Settings',
      inspectorEmptyTitle: 'Select something to edit', inspectorEmptyBody: 'Select video, audio, camera, or a zoom point on the timeline to view its properties.',
      inspectorNone: 'Nothing selected', inspectorVideo: 'Video', inspectorVoice: 'Voice over', inspectorCamera: 'Camera overlay', inspectorZoom: 'Zoom point',
      addMedia: 'Add media', recordMedia: 'Record screen', voiceMedia: 'Voice over', startVoice: 'Start voice over', exportVideo: 'Export video', snapshot: 'Save frame as PNG',
      recordTitle: 'Record your screen', recordBody: 'Choose a window, iPhone, Android device, or display and start from one place.', recordStart: 'Choose recording source', diagnostics: 'Check system readiness',
      audioTitle: 'Voice over', audioBody: 'Choose a microphone before recording from the playhead.', cameraTitle: 'Presenter camera', cameraBody: 'Camera is recorded as a separate clip that can be repositioned later.',
      exportTitle: 'Export settings', exportBody: 'Choose a resolution before opening Export.', settingsTitle: 'App and project', settingsBody: 'Language, theme, shortcuts, and diagnostics.',
      advanced: 'Advanced', advancedBody: 'Cursor, shortcut, and annotation settings are ready for the next project milestone without changing legacy rendering behavior.',
      annotationsTitle: 'Video annotations', annotationsBody: 'Choose a tool and drag on the preview to add text, arrows, frames, highlights, or blur.',
    },
  };

  let activePanel = localStorage.getItem('zoomcut-shell-panel') || 'media';
  if (!labels.th[activePanel]) activePanel = 'media';

  function shellText() {
    return labels[state.lang] || labels.en;
  }

  function setButtonText(id, text) {
    const span = document.querySelector(`#${id} > span`);
    if (span) span.textContent = text;
  }

  function syncShellLanguage() {
    const text = shellText();
    for (const tool of document.querySelectorAll('[data-shell-panel]')) {
      const key = tool.dataset.shellPanel;
      const label = tool.querySelector('[data-rail-label]');
      const railKey = `rail${key[0].toUpperCase()}${key.slice(1)}`;
      if (label && text[railKey]) label.textContent = text[railKey];
      if (text[key]) tool.title = text[key];
    }
    for (const element of document.querySelectorAll('[data-shell-copy]')) {
      if (text[element.dataset.shellCopy]) element.textContent = text[element.dataset.shellCopy];
    }
    setButtonText('shellAddMedia', text.addMedia);
    setButtonText('shellRecordMedia', text.recordMedia);
    setButtonText('shellVoiceMedia', text.voiceMedia);
    setButtonText('shellStartVoice', text.startVoice);
    setButtonText('shellExport', text.exportVideo);
    setButtonText('shellSnapshot', text.snapshot);
    document.querySelector('#inspectorEmpty strong').textContent = text.inspectorEmptyTitle;
    document.querySelector('#inspectorEmpty span').textContent = text.inspectorEmptyBody;
    document.getElementById('inspectorKicker').textContent = state.lang === 'th' ? 'คุณสมบัติ' : 'Inspector';
    setActivePanel(activePanel, false);
    updateInspectorState();
  }

  // Enhance the existing controls in place. Never clone controls: editor-app
  // owns their IDs, listeners, and state, while the shell only adds semantics.
  function enhanceInspectorPrimitives() {
    sidebar.querySelectorAll('h3').forEach((heading) => heading.classList.add('inspector-section-header'));
    sidebar.querySelectorAll('.slider-row').forEach((row) => {
      const input = row.querySelector('input[type="range"]');
      const label = row.querySelector('label');
      const output = row.querySelector('.val');
      if (!input) return;
      if (label && !label.htmlFor) label.htmlFor = input.id;
      input.setAttribute('aria-label', label?.textContent?.trim() || input.id);
      if (output) {
        output.setAttribute('role', 'status');
        output.setAttribute('aria-live', 'polite');
      }
    });
    sidebar.querySelectorAll('.segmented-control').forEach((group) => {
      group.querySelectorAll('.chip').forEach((chip) => {
        chip.setAttribute('role', 'radio');
        const active = chip.classList.contains('active');
        chip.setAttribute('tabindex', active ? '0' : '-1');
        chip.setAttribute('aria-checked', active ? 'true' : 'false');
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
    sidebar.querySelectorAll('.chip').forEach((chip) => {
      if (!chip.hasAttribute('tabindex')) chip.tabIndex = 0;
      if (chip.dataset.shellKeyboardReady) return;
      chip.dataset.shellKeyboardReady = '1';
      chip.addEventListener('keydown', (event) => {
        const group = chip.closest('.segmented-control');
        if (group && ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
          const options = [...group.querySelectorAll('.chip')]
            .filter(option => !option.disabled && option.getAttribute('aria-disabled') !== 'true');
          const current = options.indexOf(chip);
          if (current >= 0) {
            const direction = (event.key === 'ArrowLeft' || event.key === 'ArrowUp') ? -1 : 1;
            const next = options[(current + direction + options.length) % options.length];
            event.preventDefault();
            next.click();
            next.focus();
          }
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        chip.click();
      });
    });
  }

  const primitiveObserver = new MutationObserver(() => {
    sidebar.querySelectorAll('.segmented-control').forEach((group) => group.querySelectorAll('.chip').forEach((chip) => {
      const active = chip.classList.contains('active');
      chip.setAttribute('tabindex', active ? '0' : '-1');
      chip.setAttribute('aria-checked', active ? 'true' : 'false');
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    }));
  });
  primitiveObserver.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['class'] });

  function setActivePanel(next, persist = true) {
    if (!labels.th[next]) return;
    const panelChanged = activePanel !== next;
    activePanel = next;
    sidebar.dataset.activePanel = next;
    for (const element of sidebar.querySelectorAll(':scope > [data-editor-panel]')) {
      element.classList.toggle('shell-panel-visible', element.dataset.editorPanel === next);
    }
    document.getElementById('sidebarShellTitle').textContent = shellText()[next];
    document.querySelectorAll('[data-shell-panel]').forEach(tool => tool.classList.toggle('active', tool.dataset.shellPanel === next));
    if (panelChanged) {
      sidebar.scrollTop = 0;
      // The visible panel changes display state above; reset again after the
      // browser has recalculated its scroll range so a taller prior panel
      // cannot leak its offset into the new panel.
      requestAnimationFrame(() => {
        if (activePanel !== next) return;
        sidebar.scrollTop = 0;
        requestAnimationFrame(() => {
          if (activePanel === next) sidebar.scrollTop = 0;
        });
      });
    }
    shell.classList.remove('sidebar-collapsed');
    if (persist) localStorage.setItem('zoomcut-shell-panel', next);
  }

  document.querySelectorAll('[data-shell-panel]').forEach(tool => tool.addEventListener('click', () => setActivePanel(tool.dataset.shellPanel)));
  document.getElementById('sidebarCollapse').addEventListener('click', () => shell.classList.add('sidebar-collapsed'));
  document.getElementById('inspectorCollapse').addEventListener('click', () => shell.classList.add('inspector-collapsed'));

  document.getElementById('shellAddMedia').addEventListener('click', () => document.getElementById('openBtn').click());
  document.getElementById('shellRecordMedia').addEventListener('click', () => document.getElementById('quickRecord').click());
  document.getElementById('shellVoiceMedia').addEventListener('click', () => setActivePanel('audio'));
  document.getElementById('shellStartRecord').addEventListener('click', () => document.getElementById('recBtn').click());
  document.getElementById('shellDiagnostics').addEventListener('click', () => document.getElementById('diagBtn').click());
  document.getElementById('shellStartVoice').addEventListener('click', () => document.getElementById('voiceBtn').click());
  document.getElementById('shellExport').addEventListener('click', () => document.getElementById('exportBtn').click());
  document.getElementById('shellSnapshot').addEventListener('click', () => document.getElementById('snapBtn').click());

  function updateInspectorState() {
    const visible = [...inspectorContent.querySelectorAll('.marker-edit.visible')];
    const selected = visible[0] || null;
    const text = shellText();
    inspector.classList.toggle('has-selection', Boolean(selected));
    if (selected) shell.classList.remove('inspector-collapsed');
    let title = text.inspectorNone;
    if (selected?.id === 'segEdit') title = text.inspectorVideo;
    if (selected?.id === 'voiceEdit') title = text.inspectorVoice;
    if (selected?.id === 'cameraEdit') title = text.inspectorCamera;
    if (selected?.id === 'markerEdit') title = text.inspectorZoom;
    if (selected?.id === 'annotationEdit') title = state.lang === 'th' ? 'มาร์กอัป' : 'Annotation';
    document.getElementById('inspectorTitle').textContent = title;
  }

  const inspectorObserver = new MutationObserver(updateInspectorState);
  for (const panelElement of inspectorContent.querySelectorAll('.marker-edit')) {
    inspectorObserver.observe(panelElement, { attributes: true, attributeFilter: ['class'] });
  }

  const buttonIcons = {
    newBtn: ['file-plus-2', true, 'New'],
    projectOpenBtn: ['folder-open', true, 'Project'],
    projectSaveBtn: ['save', false, 'Save'],
    exportBtn: ['upload', true, 'Export'],
  };
  let decorating = false;
  function cleanButtonLabel(value, fallback) {
    const clean = String(value || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    return clean || fallback;
  }
  function decorateTopButtons() {
    if (decorating) return;
    decorating = true;
    for (const [id, [icon, showLabel, fallback]] of Object.entries(buttonIcons)) {
      const button = document.getElementById(id);
      if (!button || (button.querySelector('svg') && button.querySelector('.shell-button-label'))) continue;
      const label = cleanButtonLabel(button.textContent, fallback);
      button.innerHTML = `<i data-lucide="${icon}"></i><span class="shell-button-label"${showLabel ? '' : ' hidden'}>${label}</span>`;
    }
    if (globalThis.lucide) globalThis.lucide.createIcons();
    decorating = false;
  }
  globalThis.refreshEditorShellIcons = () => {
    decorateTopButtons();
    if (globalThis.lucide) globalThis.lucide.createIcons();
  };
  document.getElementById('langSel').addEventListener('change', () => queueMicrotask(() => {
    syncShellLanguage();
    globalThis.refreshEditorShellIcons();
  }));
  setActivePanel(activePanel, false);
  syncShellLanguage();
  enhanceInspectorPrimitives();
  updateInspectorState();
  decorateTopButtons();
  if (globalThis.lucide) globalThis.lucide.createIcons();
})();
