"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, getVersion } = require("obsidian");

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  textCards: true,
  markdownCards: true,
  placeCaretNearClick: true,
  canvasNavigation: true,
});

const DRAG_THRESHOLD_PX = 6;
const TRANSITION_TIMEOUT_MS = 1200;
const FOCUS_HOLD_MS = 300;
const INPUT_OBSERVATION_MS = 8000;
const WHEEL_LISTENER_OPTIONS = Object.freeze({ capture: true, passive: false });
const BLOCKED_TARGETS = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  ".canvas-node-resizer",
  ".canvas-node-connection-point",
  ".canvas-node-connection-point-container",
  ".canvas-node-label",
  ".canvas-node-menu",
  ".canvas-menu",
  ".clickable-icon",
  ".internal-link",
  ".external-link",
].join(",");

class CanvasOneClickEdit extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.pointerDown = null;
    this.generation = 0;
    this.timers = new Set();
    this.livePress = null;
    this.lastPress = null;
    this.lastTrace = ["No Canvas click has been captured yet."];

    // Observe events without cancelling Obsidian's own selection / drag actions.
    this.registerDomEvent(document, "pointerdown", (event) => this.onPointerDown(event), true);
    this.registerDomEvent(document, "pointermove", (event) => this.onPointerMove(event), true);
    this.registerDomEvent(document, "pointerup", (event) => this.onPointerUp(event), true);
    this.registerDomEvent(document, "pointercancel", () => this.cancelPointer(), true);
    this.registerDomEvent(window, "blur", (event) => this.onWindowBlur(event));
    this.registerDomEvent(window, "keydown", (event) => this.onWindowKeydown(event), true);
    this.initWheelNavigation();

    this.addSettingTab(new OneClickEditSettingsTab(this.app, this));
    this.addCommand({
      id: "show-last-click-diagnostics",
      name: "Show last Canvas click diagnostics",
      callback: () => new Notice(this.formatDiagnostics(), 20000),
    });
    this.addCommand({
      id: "show-last-wheel-diagnostics",
      name: "Show last Canvas scroll diagnostics",
      callback: () => new Notice(this.formatWheelDiagnostics(), 15000),
    });
  }

  onunload() {
    this.cancelPointer();
    this.cancelTransition();
    this.generation++;
    this.cleanupWheelNavigation();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  cancelPointer() {
    this.pointerDown = null;
  }

  onWindowBlur(event) {
    // Obsidian relays Canvas iframe blur events to the parent window. A blur
    // of A's editor during B's click is NOT the user leaving the app.
    if (event?.isRelayed || document.hasFocus()) return;
    if (this.pointerDown) this.lastTrace.push("Cancelled: app lost focus");
    this.cancelPointer();
    this.generation++;
    this.cancelTransition();
  }

  cancelTransition() {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    if (this.livePress) {
      this.livePress.inputCleanup?.();
      this.livePress.inputCleanup = null;
      this.livePress = null;
    }
  }

  schedulePress(press, callback, delay) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (this.isCurrentPress(press)) callback();
    }, delay);
    this.timers.add(timer);
  }

  onPointerDown(event) {
    this.cancelTransition();
    this.pointerDown = null;
    this.generation++;

    if (!this.settings.enabled || !this.isPlainPrimaryClick(event)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(BLOCKED_TARGETS)) return;

    const nodeEl = target.closest(".canvas-node");
    if (!nodeEl || !nodeEl.isConnected) return;

    const match = this.findCanvasNode(nodeEl);
    if (!match || !this.isEditable(match.canvas, match.node)) return;

    this.lastTrace = ["Clicked editable card"];
    // Never display an older click's successful diagnosis after a newer click
    // was captured but cancelled before pointerup (e.g. during a drag).
    this.lastPress = null;

    this.pointerDown = {
      pointerId: event.pointerId,
      nodeEl,
      canvas: match.canvas,
      node: match.node,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      generation: this.generation,
    };
  }

  onPointerMove(event) {
    const press = this.pointerDown;
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD_PX) {
      if (!press.moved) this.lastTrace.push("Dragging: no auto editing");
      press.moved = true;
    }
  }

  onPointerUp(event) {
    const press = this.pointerDown;
    this.pointerDown = null;
    if (!press || press.pointerId !== event.pointerId || press.moved) return;
    if (!this.isPlainPrimaryClick(event)) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD_PX) return;

    // Pointer capture may retarget pointerup to Canvas. Use geometry instead.
    const rect = press.nodeEl.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) return;

    this.lastTrace.push("Released without dragging");

    press.trace = this.lastTrace;
    press.startedAt = performance.now();
    press.stableSince = null;
    press.stableIdentity = null;
    press.editRequested = false;
    press.userKey = false;
    press.observation = {
      samples: [], keys: 0, keysElsewhere: 0, preventedKeys: 0,
      beforeInput: 0, input: 0, documentChanged: false,
    };
    this.livePress = this.lastPress = press;
    this.schedulePress(press, () => {
      press.inputCleanup?.();
      press.inputCleanup = null;
      if (this.livePress === press) this.livePress = null;
    }, INPUT_OBSERVATION_MS);

    // A timer runs after the pointerup/click task. Selection alone is NOT proof
    // that Canvas has called the old node's blur() and the new node's focus().
    this.schedulePress(press, () => {
      if (!this.isCurrentPress(press)) return;
      const selected = press.canvas.selection?.size === 1 &&
        press.canvas.selection.has(press.node);
      if (!selected) {
        if (press.canvas.selection?.size > 1) {
          press.trace.push("Multiple selection: unchanged");
          return;
        }
        if (typeof press.canvas.selectOnly !== "function") return;
        try {
          press.canvas.selectOnly(press.node);
          press.trace.push("Selected target");
        } catch (error) {
          console.warn("Canvas One Click Edit: failed to switch selection", error);
          return;
        }
      }
      this.advanceTransition(press);
    }, 0);
  }

  isSelectionSettled(press) {
    const { canvas, node, nodeEl } = press;
    if (canvas.selection?.size !== 1 || !canvas.selection.has(node)) return false;
    if (canvas.staleSelection || canvas.isDragging) return false;
    if (typeof node.isFocused === "boolean") return node.isFocused;
    return nodeEl.classList?.contains("is-focused") === true;
  }

  isCurrentPress(press) {
    return press.generation === this.generation && this.settings.enabled &&
      press.nodeEl.isConnected && this.isEditable(press.canvas, press.node);
  }

  advanceTransition(press) {
    if (!this.isCurrentPress(press)) return;
    if (press.canvas.selection?.size !== 1 || !press.canvas.selection.has(press.node)) {
      press.trace.push("Target selection was lost");
      return;
    }
    // Do not steal focus back from another app, DevTools, or a dialog.
    if (press.nodeEl.ownerDocument.hasFocus?.() === false) return;
    const elapsed = performance.now() - press.startedAt;
    if (!this.isSelectionSettled(press)) {
      press.stableSince = null;
      press.stableIdentity = null;
      press.focusHeld = false;
      if (elapsed >= TRANSITION_TIMEOUT_MS) {
        press.trace.push("Selection transition did not settle");
        return;
      }
      this.schedulePress(press, () => this.advanceTransition(press), 25);
      return;
    }

    if (!press.editRequested) {
      press.editRequested = true;
      try {
        // Native blur() saves/closes A during selection reconciliation. Never
        // replace it with setIsEditing(false), which only changes a flag/CSS.
        if (press.node.child?.getMode?.() !== "source" || !press.node.isEditing) {
          const point = this.settings.placeCaretNearClick ? { x: press.x, y: press.y } : undefined;
          press.node.startEditing(point);
        }
        press.trace.push("Native selection settled; requested editor");
      } catch (error) {
        console.warn("Canvas One Click Edit: failed to start editing", error);
        press.trace.push("Edit mode threw an error");
        return;
      }
    }

    const state = this.editorState(press.node);
    press.lastState = this.summarizeState(state);
    if (state.ready) this.attachInputTracking(press, state);

    const identity = press.stableIdentity;
    if (!identity || identity.mode !== state.mode || identity.cm !== state.cm ||
        identity.doc !== state.cm?.contentDOM?.ownerDocument) {
      press.stableIdentity = { mode: state.mode, cm: state.cm, doc: state.cm?.contentDOM?.ownerDocument };
      press.stableSince = null;
    }

    if (state.ready && state.writable && !state.focused && !press.userKey) {
      try {
        // Wait for iframe load/reparent + cm.setRoot before native focus().
        // Native startEditing(point) alone positions the caret, exactly once.
        state.mode.focus();
      } catch (error) {
        console.debug("Canvas One Click Edit: focus not ready", error);
      }
    }

    // Deliberately sample before any focus() call takes effect on this tick.
    // A single true result must never end the observation window.
    if (state.ready && state.writable && state.focused) {
      if (press.stableSince === null) press.stableSince = performance.now();
    } else {
      press.stableSince = null;
    }
    press.focusHeld = press.stableSince !== null && performance.now() - press.stableSince >= FOCUS_HOLD_MS;
    const lastSample = press.observation.samples.at(-1);
    if (!lastSample || elapsed - lastSample.ms >= 200 || elapsed >= TRANSITION_TIMEOUT_MS) {
      press.observation.samples.push({ ms: Math.round(elapsed), ...press.lastState });
    }

    if (elapsed < TRANSITION_TIMEOUT_MS) {
      this.schedulePress(press, () => this.advanceTransition(press), 25);
    } else {
      press.trace.push(press.focusHeld ? "Focus held >=300ms (not a typing test)" : "Focus/mode NOT stable");
    }
  }

  editorState(node) {
    const child = node?.child;
    const mode = child?.editMode;
    const cm = mode?.cm;
    const frame = mode?.iframeEl || null;
    const content = cm?.contentDOM;
    const doc = content?.ownerDocument;
    const source = child?.getMode?.() === "source";
    const editing = node?.isEditing === true;
    let owned = false;
    let frameReady = !frame;
    try {
      owned = !!(content?.isConnected && cm.dom?.isConnected && cm.dom.contains(content) &&
        (frame ? frame.isConnected && node.nodeEl.contains(frame) && frame.contentDocument === doc
          : node.nodeEl.contains(cm.dom)));
      if (frame) frameReady = frame.contentDocument?.readyState === "complete";
    } catch (_) { /* A non-Markdown or inaccessible iframe is never a target. */ }
    const rootMatches = !!doc && cm?.root === (content.getRootNode?.() || doc);
    const readOnly = cm?.state?.readOnly;
    const editable = content?.isContentEditable === true && cm?.editable !== false;
    const ready = source && editing && owned && frameReady && rootMatches && cm?.destroyed !== true;
    const writable = ready && readOnly === false && editable;
    const focused = ready && cm.hasFocus === true && doc.activeElement === content && this.isDocumentForeground(doc);
    const vim = cm?.cm?.vim;
    return { mode, cm, frame, source, editing, owned, frameReady, rootMatches, ready, readOnly,
      editable, writable, focused, vimNormal: !!vim && !vim.insertMode };
  }

  isDocumentForeground(doc) {
    try {
      if (doc?.hasFocus?.() === false) return false;
      let frame = doc?.defaultView?.frameElement;
      while (frame) {
        if (frame.ownerDocument?.activeElement !== frame) return false;
        frame = frame.ownerDocument?.defaultView?.frameElement;
      }
      return true;
    } catch (_) { return false; }
  }

  summarizeState(state) {
    return Object.fromEntries(["source", "editing", "owned", "frameReady", "rootMatches", "ready",
      "readOnly", "editable", "writable", "focused", "vimNormal"].map((key) => [key, state[key]]));
  }

  isTypingKey(event) {
    return !event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key?.length === 1 || ["Enter", "Backspace", "Delete", "Process"].includes(event.key));
  }

  onWindowKeydown(event) {
    const press = this.livePress;
    if (!press) return;
    if (event.key === "Escape" || event.key === "Tab" || event.ctrlKey || event.metaKey || event.altKey) {
      this.generation++;
      this.cancelTransition();
      return;
    }
    if (!this.isTypingKey(event) || !this.isCurrentPress(press)) return;
    const state = this.editorState(press.node);
    // Iframe keyboard events are relayed by Obsidian to window. The real
    // content listener below counts editor events, so do not count them twice.
    if (event.target?.nodeType && state.cm?.contentDOM?.contains(event.target)) return;
    press.userKey = true;
    press.observation.keysElsewhere++;
  }

  attachInputTracking(press, state) {
    if (press.observedCM === state.cm) return;
    press.inputCleanup?.();
    press.observedCM = state.cm;
    const cm = state.cm;
    const content = cm.contentDOM;
    const observation = press.observation;
    const checkDocument = (before) => this.schedulePress(press, () => {
      if (press.node.child?.editMode?.cm === cm && cm.state.doc !== before) observation.documentChanged = true;
    }, 50);
    const onKey = (event) => {
      if (!this.isTypingKey(event)) return;
      press.userKey = true;
      observation.keys++;
      const before = cm.state.doc;
      this.schedulePress(press, () => { if (event.defaultPrevented) observation.preventedKeys++; }, 0);
      checkDocument(before);
    };
    const onBeforeInput = () => {
      press.userKey = true;
      observation.beforeInput++;
      checkDocument(cm.state.doc);
    };
    const onInput = () => { press.userKey = true; observation.input++; };
    const onComposition = () => { press.userKey = true; };
    content.addEventListener("keydown", onKey, true);
    content.addEventListener("beforeinput", onBeforeInput, true);
    content.addEventListener("input", onInput, true);
    content.addEventListener("compositionstart", onComposition, true);
    press.inputCleanup = () => {
      content.removeEventListener("keydown", onKey, true);
      content.removeEventListener("beforeinput", onBeforeInput, true);
      content.removeEventListener("input", onInput, true);
      content.removeEventListener("compositionstart", onComposition, true);
    };
  }

  formatDiagnostics() {
    const press = this.lastPress;
    let version = "unknown";
    try { version = getVersion(); } catch (_) { /* Optional compatibility info. */ }
    const lines = [`Canvas One Click Edit ${this.manifest?.version || "0.6.0"} / Obsidian ${version}`];
    if (!press) return lines.concat(this.lastTrace).join("\n");
    lines.push(press.trace.slice(2).join(" → ") || "Waiting for native selection/editor");
    const s = press.lastState;
    if (s) {
      const bit = (value) => value === undefined ? "?" : value ? "1" : "0";
      lines.push(`B: source=${bit(s.source)} editing=${bit(s.editing)} ready=${bit(s.ready)} writable=${bit(s.writable)}`);
      lines.push(`Owned=${bit(s.owned)} frame=${bit(s.frameReady)} root=${bit(s.rootMatches)} readonly=${bit(s.readOnly)} Vim-normal=${bit(s.vimNormal)}`);
      lines.push(`Focus samples: ${press.observation.samples.map((sample) => `${sample.ms}ms:${bit(sample.focused)}`).join(" ")}`);
    }
    const o = press.observation;
    lines.push(`Keys in B=${o.keys}; elsewhere=${o.keysElsewhere}; prevented=${o.preventedKeys}`);
    lines.push(`Beforeinput=${o.beforeInput}; input=${o.input}; B document changed=${o.documentChanged ? "yes" : "no"}`);
    return lines.join("\n");
  }

  isPlainPrimaryClick(event) {
    return event.button === 0 && event.isPrimary !== false &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
  }

  isEditable(canvas, node) {
    if (!canvas || canvas.readonly || canvas.isReadonly === true ||
        !node || typeof node.startEditing !== "function") return false;

    const data = typeof node.getData === "function" ? node.getData() : node;
    if (data.type === "text") return this.settings.textCards;
    if (data.type === "file" && this.settings.markdownCards) {
      // Do not trigger editing for PDFs, images or other media cards.
      return typeof data.file === "string" && data.file.toLowerCase().endsWith(".md");
    }
    return false;
  }

  findCanvasNode(nodeEl) {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const canvas = leaf.view?.canvas;
      if (!canvas?.nodes) continue;
      if (!leaf.view.containerEl?.contains(nodeEl)) continue;

      const values = canvas.nodes instanceof Map
        ? canvas.nodes.values()
        : Object.values(canvas.nodes);
      for (const node of values) {
        if (!node?.nodeEl) continue;
        if (node.nodeEl === nodeEl || node.nodeEl.closest?.(".canvas-node") === nodeEl) {
          return { canvas, node };
        }
      }
    }
    return null;
  }

  initWheelNavigation() {
    // Navigation has its own lifetime. Click diagnostics expire after 8s, but
    // scrolling must keep working for as long as the Canvas/editor is open.
    this.wheelCanvasBindings = new Map();
    this.wheelFrameBindings = new Map();
    this.wheelForwarded = new WeakSet();
    this.wheelRefreshTimer = null;
    this.wheelStopped = false;
    this.lastWheelTrace = "No horizontal/zoom gesture captured yet.";
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleWheelRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleWheelRefresh()));
    this.app.workspace.onLayoutReady(() => {
      if (!this.wheelStopped) this.refreshWheelBindings();
    });
  }

  scheduleWheelRefresh() {
    if (this.wheelStopped || this.wheelRefreshTimer !== null) return;
    this.wheelRefreshTimer = window.setTimeout(() => {
      this.wheelRefreshTimer = null;
      if (!this.wheelStopped) this.refreshWheelBindings();
    }, 0);
  }

  refreshWheelBindings() {
    if (this.wheelStopped) return;
    const wanted = new Set();
    if (this.settings.canvasNavigation !== false) {
      for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
        const canvas = leaf.view?.canvas;
        if (!canvas?.wrapperEl?.isConnected || typeof canvas.onWheel !== "function") continue;
        wanted.add(canvas);
        let binding = this.wheelCanvasBindings.get(canvas);
        if (binding && binding.wrapper !== canvas.wrapperEl) {
          this.removeWheelCanvas(binding);
          binding = null;
        }
        if (!binding) binding = this.bindWheelCanvas(canvas);
        this.syncWheelFrames(binding);
      }
    }
    for (const [canvas, binding] of this.wheelCanvasBindings) {
      if (!wanted.has(canvas)) this.removeWheelCanvas(binding);
    }
  }

  bindWheelCanvas(canvas) {
    const wrapper = canvas.wrapperEl;
    const handler = (event) => this.onCanvasWheel(event, { canvas });
    wrapper.addEventListener("wheel", handler, WHEEL_LISTENER_OPTIONS);
    const binding = { canvas, wrapper, handler, observer: null };
    const Observer = wrapper.ownerDocument.defaultView.MutationObserver;
    if (typeof Observer === "function") {
      binding.observer = new Observer((records) => {
        // Text edits can generate many DOM mutations. Rescan only if an iframe
        // was inserted/removed, not on every keystroke or viewport transform.
        if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
          node.nodeType === 1 && (node.tagName === "IFRAME" || node.querySelector?.("iframe"))))) {
          this.scheduleWheelRefresh();
        }
      });
      binding.observer.observe(wrapper, { childList: true, subtree: true });
    }
    this.wheelCanvasBindings.set(canvas, binding);
    return binding;
  }

  syncWheelFrames(binding) {
    const { canvas, wrapper } = binding;
    const wanted = new Set();
    const nodes = typeof canvas.nodes?.values === "function" ? canvas.nodes.values() : Object.values(canvas.nodes || {});
    for (const node of nodes) {
      // Only Obsidian's own Markdown editor frame: never inspect embedded web
      // pages/PDF viewers or arbitrary iframes in a note.
      const frame = node.child?.editMode?.iframeEl;
      if (!frame?.isConnected || !wrapper.contains(frame) || !node.nodeEl?.contains(frame)) continue;
      wanted.add(frame);
      const record = this.wheelFrameBindings.get(frame);
      if (record && (record.canvas !== canvas || record.node !== node)) this.removeWheelFrame(record);
      if (!this.wheelFrameBindings.has(frame)) this.bindWheelFrame(frame, canvas, node);
      else this.rebindWheelFrame(this.wheelFrameBindings.get(frame));
    }
    for (const [frame, record] of this.wheelFrameBindings) {
      if (record.canvas === canvas && !wanted.has(frame)) this.removeWheelFrame(record);
    }
  }

  bindWheelFrame(frame, canvas, node) {
    const record = { frame, canvas, node, doc: null, handler: null, onLoad: null };
    record.onLoad = () => this.rebindWheelFrame(record);
    frame.addEventListener("load", record.onLoad);
    this.wheelFrameBindings.set(frame, record);
    this.rebindWheelFrame(record);
    return record;
  }

  rebindWheelFrame(record) {
    if (this.wheelStopped || this.wheelFrameBindings.get(record.frame) !== record) return;
    let doc = null;
    try { doc = record.frame.contentDocument; } catch (_) { /* Ignore inaccessible frames. */ }
    if (record.doc === doc) return;
    if (record.doc && record.handler) record.doc.removeEventListener("wheel", record.handler, WHEEL_LISTENER_OPTIONS);
    record.doc = doc;
    record.handler = null;
    if (doc) {
      record.handler = (event) => this.onCanvasWheel(event, record);
      doc.addEventListener("wheel", record.handler, WHEEL_LISTENER_OPTIONS);
    }
  }

  removeWheelFrame(record) {
    if (record.doc && record.handler) record.doc.removeEventListener("wheel", record.handler, WHEEL_LISTENER_OPTIONS);
    record.frame.removeEventListener("load", record.onLoad);
    this.wheelFrameBindings.delete(record.frame);
    record.doc = null;
    record.handler = null;
  }

  removeWheelCanvas(binding) {
    binding.wrapper.removeEventListener("wheel", binding.handler, WHEEL_LISTENER_OPTIONS);
    binding.observer?.disconnect();
    for (const record of this.wheelFrameBindings.values()) {
      if (record.canvas === binding.canvas) this.removeWheelFrame(record);
    }
    this.wheelCanvasBindings.delete(binding.canvas);
  }

  cleanupWheelNavigation() {
    this.wheelStopped = true;
    if (this.wheelRefreshTimer !== null) window.clearTimeout(this.wheelRefreshTimer);
    this.wheelRefreshTimer = null;
    for (const binding of this.wheelCanvasBindings?.values() || []) this.removeWheelCanvas(binding);
    for (const record of this.wheelFrameBindings?.values() || []) this.removeWheelFrame(record);
  }

  wheelIntent(event, canvas) {
    if (event.defaultPrevented || event.cancelable === false) return null;
    // Read deltaMode before delta values; preserve units for Canvas itself to
    // normalize. Mouse wheels and trackpads do not always use pixel deltas.
    const deltaMode = event.deltaMode;
    const dx = event.deltaX;
    const dy = event.deltaY;
    if (![dx, dy, deltaMode].every(Number.isFinite)) return null;
    if (dx === 0 && dy === 0 && !event.ctrlKey) return null;
    if (event.ctrlKey || event.metaKey || canvas.isHoldingSpace) {
      return { kind: "native-zoom", deltaX: dx, deltaY: dy, deltaMode,
        ctrlKey: !!event.ctrlKey, metaKey: !!event.metaKey, shiftKey: !!event.shiftKey, altKey: !!event.altKey,
        wheelDeltaX: event.wheelDeltaX, wheelDeltaY: event.wheelDeltaY };
    }
    const shiftHorizontal = event.shiftKey && dx === 0 && dy !== 0;
    if (!shiftHorizontal && Math.abs(dx) <= Math.abs(dy)) return null;
    return { kind: "pan", deltaX: shiftHorizontal ? dy : dx, deltaY: 0, deltaMode,
      // Native Canvas can use wheel-to-zoom by default. Invert its modifier
      // only in this private forwarded event to request horizontal PAN.
      // No setting, keyboard state, or original event is changed.
      ctrlKey: false, metaKey: canvas.options?.defaultWheelBehavior === "zoom", shiftKey: false, altKey: false,
      wheelDeltaX: (shiftHorizontal ? event.wheelDeltaY : event.wheelDeltaX) || 0, wheelDeltaY: 0 };
  }

  onCanvasWheel(event, context) {
    if (this.wheelStopped || this.settings.canvasNavigation === false || this.wheelForwarded?.has(event)) return false;
    const canvas = context?.canvas;
    const wrapper = canvas?.wrapperEl;
    if (!wrapper?.isConnected || canvas.isDragging || typeof canvas.onWheel !== "function") return false;
    const intent = this.wheelIntent(event, canvas);
    if (!intent) return false; // Ordinary vertical node scrolling is untouched.

    let node = context.node;
    const frame = context.frame;
    if (frame) {
      try {
        const eventDoc = event.target?.nodeType === 9 ? event.target : event.target?.ownerDocument;
        if (!frame.isConnected || !node?.nodeEl?.isConnected || !node.nodeEl.contains(frame) ||
            !wrapper.contains(node.nodeEl) || node.child?.editMode?.iframeEl !== frame ||
            eventDoc !== frame.contentDocument) return false;
      } catch (_) { return false; }
    } else {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      const nodeEl = target?.closest?.(".canvas-node");
      if (!nodeEl?.isConnected || !wrapper.contains(nodeEl)) return false;
      node = [...(canvas.selection || [])].find((selected) => selected.nodeEl === nodeEl);
    }
    if (!node || !canvas.selection?.has(node)) return false;
    // Navigation remains usable on a locked Canvas and does not depend on
    // whether one-click editing is enabled or this node is currently editing.
    return this.forwardCanvasWheel(event, { canvas, node, frame }, intent);
  }

  canvasWheelPoint(event, canvas, frame) {
    let x = event.clientX;
    let y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!frame) return { x, y };
    const destination = canvas.wrapperEl.ownerDocument;
    try {
      let current = frame;
      for (let depth = 0; current && depth < 10; depth++) {
        const rect = current.getBoundingClientRect();
        const width = current.offsetWidth || current.clientWidth;
        const height = current.offsetHeight || current.clientHeight;
        if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0)) return null;
        x = rect.left + (x + (current.clientLeft || 0)) * rect.width / width;
        y = rect.top + (y + (current.clientTop || 0)) * rect.height / height;
        if (current.ownerDocument === destination) return { x, y };
        current = current.ownerDocument.defaultView?.frameElement;
      }
    } catch (_) { /* Do not guess coordinates across an inaccessible frame. */ }
    return null;
  }

  forwardCanvasWheel(event, context, intent) {
    const { canvas, frame } = context;
    const wrapper = canvas.wrapperEl;
    const point = this.canvasWheelPoint(event, canvas, frame);
    const Wheel = wrapper.ownerDocument.defaultView.WheelEvent;
    if (!point || typeof Wheel !== "function") return false;
    let forwarded;
    let nativeCompleted = false;
    try {
      forwarded = new Wheel("wheel", { ...intent, clientX: point.x, clientY: point.y,
        view: wrapper.ownerDocument.defaultView, bubbles: true, cancelable: true, composed: true });
      // Native Canvas's scrollable-ancestor guard must see the wrapper, not the
      // card's vertical scroller. This event is called directly, not dispatched
      // globally, and cannot trigger browser page zoom or unrelated handlers.
      Object.defineProperties(forwarded, {
        target: { value: wrapper }, targetNode: { value: wrapper }, currentTarget: { value: wrapper },
        wheelDeltaX: { value: intent.wheelDeltaX }, wheelDeltaY: { value: intent.wheelDeltaY },
      });
      this.wheelForwarded?.add(forwarded);
      canvas.onWheel(forwarded);
      nativeCompleted = true;
    } catch (error) {
      this.lastWheelTrace = "Native Canvas wheel routing failed.";
      console.warn("Canvas One Click Edit: wheel routing failed", error);
    }
    // macOS double-tap/smart zoom is a zero-delta ctrl gesture; that native
    // branch does not call preventDefault. Other ignored events stay native.
    const smartZoom = nativeCompleted && intent.ctrlKey && intent.deltaX === 0 && intent.deltaY === 0 &&
      typeof canvas.smartZoom === "function";
    if (!forwarded?.defaultPrevented && !smartZoom) return false;
    event.preventDefault();
    event.stopPropagation();
    if (nativeCompleted) {
      this.lastWheelTrace = `${intent.kind === "pan" ? "Horizontal pan" : "Native zoom gesture"} → Canvas; ` +
        `source=${frame ? "editor iframe" : "card"}; deltaX=${intent.deltaX}; deltaY=${intent.deltaY}; mode=${intent.deltaMode}`;
    }
    return true;
  }

  formatWheelDiagnostics() {
    return [`Canvas One Click Edit ${this.manifest?.version || "0.6.0"}`,
      `Canvas navigation: ${this.settings.canvasNavigation === false ? "OFF" : "ON"}`,
      `Bound Canvas views=${this.wheelCanvasBindings?.size || 0}; editor frames=${this.wheelFrameBindings?.size || 0}`,
      this.lastWheelTrace || "No horizontal/zoom gesture captured yet."].join("\n");
  }

}

class OneClickEditSettingsTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Enable one-click editing")
      .setDesc("Click a Canvas card once to start typing. Dragging and modifier-clicks are unchanged.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Text cards")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.textCards).onChange(async (value) => {
        this.plugin.settings.textCards = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Markdown note cards")
      .setDesc("File cards linked to .md notes only; images, PDFs and web cards are excluded.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.markdownCards).onChange(async (value) => {
        this.plugin.settings.markdownCards = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Place cursor near click")
      .setDesc("Best effort. Depends on Canvas internals, zoom and the active editor.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.placeCaretNearClick).onChange(async (value) => {
        this.plugin.settings.placeCaretNearClick = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Canvas navigation over selected cards")
      .setDesc("Keep vertical scrolling inside the card; route horizontal scrolling and native zoom gestures to Canvas. Turn off to scroll wide code blocks/tables horizontally inside a card.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.canvasNavigation).onChange(async (value) => {
        this.plugin.settings.canvasNavigation = value;
        this.plugin.refreshWheelBindings();
        await this.plugin.saveSettings();
      }));
  }

  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
}

module.exports = CanvasOneClickEdit;
