// topg — client-side dashboard
// Vanilla JS, no framework, no build step.

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────

  const state = {
    sessions: [],          // SessionMeta[]
    currentSessionId: null,
    currentMessages: [],   // Message[]
    currentMeta: null,     // SessionMeta
    ws: null,              // WebSocket
    reconnectDelay: 1000,
  };

  // ── DOM refs ───────────────────────────────────────────────────────

  const $id = (id) => document.getElementById(id);

  // ── Utilities ──────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function relativeTime(isoString) {
    if (!isoString) return "";
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffSec = Math.floor((now - then) / 1000);

    if (diffSec < 60) return "now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + "m ago";
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    const diffDay = Math.floor(diffHr / 24);
    return diffDay + "d ago";
  }

  function showView(viewId) {
    const views = ["empty-state", "debate-viewer", "new-debate-form"];
    for (const id of views) {
      const el = $id(id);
      if (el) el.style.display = id === viewId ? "" : "none";
    }
  }

  function parseContent(text) {
    if (!text) return "";
    const escaped = escapeHtml(text);

    // Split on code fences: ```lang\n...\n```
    // The regex captures: (lang)? and (code body)
    const parts = escaped.split(/(```[\s\S]*?```)/g);
    let html = "";

    for (const part of parts) {
      const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (fenceMatch) {
        const lang = fenceMatch[1];
        const code = fenceMatch[2];
        html += '<pre><code' + (lang ? ' class="lang-' + lang + '"' : '') + '>' + code + '</code></pre>';
      } else {
        // Split on double newlines into paragraphs
        const paragraphs = part.split(/\n\n+/);
        for (const p of paragraphs) {
          const trimmed = p.trim();
          if (trimmed) {
            html += "<p>" + trimmed.replace(/\n/g, "<br>") + "</p>";
          }
        }
      }
    }
    return html;
  }

  // ── WebSocket ──────────────────────────────────────────────────────

  function connectWs() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + location.host);

    ws.addEventListener("open", function () {
      state.reconnectDelay = 1000;
      state.ws = ws;
    });

    ws.addEventListener("close", function () {
      state.ws = null;
      setTimeout(function () {
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
        connectWs();
      }, state.reconnectDelay);
    });

    ws.addEventListener("error", function (e) {
      console.error("[topg] WebSocket error:", e);
    });

    ws.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.error("[topg] Failed to parse message:", e);
        return;
      }
      handleMessage(msg);
    });
  }

  // ── Message dispatch ───────────────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {
      case "sessions.list":
        handleSessionsList(msg);
        break;
      case "session.updated":
        handleSessionUpdated(msg);
        break;
      case "turn.start":
        handleTurnStart(msg);
        break;
      case "turn.complete":
        handleTurnComplete(msg);
        break;
      case "debate.started":
        handleDebateStarted(msg);
        break;
      case "debate.result":
        handleDebateResult(msg);
        break;
      case "error":
        console.error("[topg] Server error:", msg.code, msg.message);
        break;
      default:
        console.warn("[topg] Unknown message type:", msg.type);
    }
  }

  function handleSessionsList(msg) {
    state.sessions = msg.sessions || [];
    renderSessionList();
  }

  function handleSessionUpdated(msg) {
    var session = msg.session;
    if (!session) return;

    // Update in local list
    var idx = state.sessions.findIndex(function (s) {
      return s.sessionId === session.sessionId;
    });
    if (idx >= 0) {
      state.sessions[idx] = session;
    } else {
      state.sessions.unshift(session);
    }

    renderSessionList();

    // Update status badge if viewing this session
    if (state.currentSessionId === session.sessionId) {
      state.currentMeta = session;
      updateStatusBadge(session.status);
      updateActionButtons(session.status);
    }
  }

  function handleDebateStarted(msg) {
    // Server confirmed a new debate was created — select it immediately
    if (msg.sessionId) {
      selectSession(msg.sessionId);
    }
  }

  function handleTurnStart(msg) {
    if (msg.sessionId !== state.currentSessionId) return;

    var indicator = $id("typing-indicator");
    var label = $id("typing-label");
    if (indicator) indicator.style.display = "";
    if (label) {
      if (msg.role === "synthesis") {
        label.textContent = "Synthesizing final answer...";
      } else {
        var agentLabel = msg.agent === "claude" ? "Claude" : "Codex";
        label.textContent = agentLabel + " is thinking...";
      }
    }
  }

  function handleTurnComplete(msg) {
    if (msg.sessionId !== state.currentSessionId) return;

    // Hide typing indicator
    var indicator = $id("typing-indicator");
    if (indicator) indicator.style.display = "none";

    // Append message
    var message = msg.message;
    if (message) {
      state.currentMessages.push(message);
      var thread = $id("thread");
      if (thread) {
        thread.appendChild(renderMessage(message));
        thread.scrollTop = thread.scrollHeight;
      }
      updateConvergenceBar();
    }
  }

  function handleDebateResult(msg) {
    if (msg.sessionId !== state.currentSessionId) return;

    // Hide typing indicator
    var indicator = $id("typing-indicator");
    if (indicator) indicator.style.display = "none";

    var result = msg.result;
    if (!result) return;

    // Show outcome bar
    var outcomeBar = $id("outcome-bar");
    if (outcomeBar) {
      outcomeBar.style.display = "";
      outcomeBar.className = "outcome-bar " + result.type;

      if (result.type === "consensus") {
        outcomeBar.textContent = "Consensus reached after " + result.rounds + " rounds";
      } else {
        outcomeBar.textContent = "Escalated after " + result.rounds + " rounds — human guidance needed";
      }
    }

    // Show guidance bar for escalation
    if (result.type === "escalation") {
      var guidanceBar = $id("guidance-bar");
      if (guidanceBar) guidanceBar.style.display = "";
    }

    // Update status badge
    var newStatus = result.type === "consensus" ? "completed" : "escalated";
    updateStatusBadge(newStatus);
    updateActionButtons(newStatus);
  }

  // ── Session List ───────────────────────────────────────────────────

  function renderSessionList() {
    var container = $id("session-list");
    if (!container) return;
    container.innerHTML = "";

    // Group: active first, then the rest
    var activeSessions = [];
    var recentSessions = [];

    for (var i = 0; i < state.sessions.length; i++) {
      var s = state.sessions[i];
      if (s.status === "active") {
        activeSessions.push(s);
      } else {
        recentSessions.push(s);
      }
    }

    if (activeSessions.length > 0) {
      container.appendChild(createGroupLabel("Active"));
      for (var j = 0; j < activeSessions.length; j++) {
        container.appendChild(createSessionItem(activeSessions[j]));
      }
    }

    if (recentSessions.length > 0) {
      container.appendChild(createGroupLabel("Recent"));
      for (var k = 0; k < recentSessions.length; k++) {
        container.appendChild(createSessionItem(recentSessions[k]));
      }
    }
  }

  function createGroupLabel(text) {
    var label = document.createElement("div");
    label.className = "session-group-label";
    label.style.cssText = "font-size:10px;color:var(--text-dim);padding:8px 12px 4px;text-transform:uppercase;letter-spacing:0.5px;";
    label.textContent = text;
    return label;
  }

  function createSessionItem(session) {
    var isSelected = session.sessionId === state.currentSessionId;
    var div = document.createElement("div");
    div.className = "session-item" + (isSelected ? " active" : "");
    div.setAttribute("data-session-id", session.sessionId);

    // Truncate prompt
    var promptText = session.prompt || "";
    if (promptText.length > 80) {
      promptText = promptText.slice(0, 80) + "...";
    }

    // Count rounds from config guardrail or infer from messages
    var roundsText = "";
    if (session.config && session.config.guardrailRounds) {
      roundsText = session.config.guardrailRounds + " max rounds";
    }

    div.innerHTML =
      '<div class="session-prompt">' + escapeHtml(promptText) + '</div>' +
      '<div class="session-meta">' +
        '<span class="session-dot ' + escapeHtml(session.status) + '"></span> ' +
        '<span>' + escapeHtml(roundsText) + '</span>' +
        '<span class="sep">&middot;</span> ' +
        '<span>' + relativeTime(session.updatedAt) + '</span>' +
      '</div>';

    div.addEventListener("click", function () {
      selectSession(session.sessionId);
    });

    return div;
  }

  // ── Select Session ─────────────────────────────────────────────────

  function selectSession(sessionId) {
    state.currentSessionId = sessionId;

    fetch("/api/sessions/" + encodeURIComponent(sessionId))
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch session");
        return res.json();
      })
      .then(function (data) {
        state.currentMessages = data.messages || [];
        state.currentMeta = data.meta || null;
        showView("debate-viewer");
        renderDebateViewer();
        renderSessionList();
      })
      .catch(function (err) {
        console.error("[topg] Failed to load session:", err);
      });
  }

  // ── Debate Viewer ──────────────────────────────────────────────────

  function renderDebateViewer() {
    var meta = state.currentMeta;
    if (!meta) return;

    // Prompt
    var promptEl = $id("debate-prompt");
    if (promptEl) promptEl.textContent = meta.prompt || "";

    // Status badge
    updateStatusBadge(meta.status);

    // Action buttons
    updateActionButtons(meta.status);

    // Convergence bar
    updateConvergenceBar();

    // Thread
    var thread = $id("thread");
    if (thread) {
      thread.innerHTML = "";
      for (var i = 0; i < state.currentMessages.length; i++) {
        thread.appendChild(renderMessage(state.currentMessages[i]));
      }
      thread.scrollTop = thread.scrollHeight;
    }

    // Typing indicator — hide by default
    var indicator = $id("typing-indicator");
    if (indicator) indicator.style.display = "none";

    // Outcome bar
    var outcomeBar = $id("outcome-bar");
    if (outcomeBar) {
      if (meta.status === "completed") {
        outcomeBar.style.display = "";
        outcomeBar.className = "outcome-bar consensus";
        outcomeBar.textContent = "Consensus reached";
      } else if (meta.status === "escalated") {
        outcomeBar.style.display = "";
        outcomeBar.className = "outcome-bar escalation";
        outcomeBar.textContent = "Escalated — human guidance needed";
      } else {
        outcomeBar.style.display = "none";
        outcomeBar.className = "outcome-bar";
        outcomeBar.textContent = "";
      }
    }

    // Guidance bar
    var guidanceBar = $id("guidance-bar");
    if (guidanceBar) {
      guidanceBar.style.display = meta.status === "escalated" ? "" : "none";
    }
  }

  function updateStatusBadge(status) {
    var badge = $id("debate-status");
    if (!badge) return;
    badge.className = "status-badge " + status;
    badge.textContent = status;
  }

  function updateActionButtons(status) {
    var pauseBtn = $id("pause-btn");
    var resumeBtn = $id("resume-btn");

    if (pauseBtn) {
      pauseBtn.style.display = status === "active" ? "" : "none";
    }
    if (resumeBtn) {
      resumeBtn.style.display = status === "paused" ? "" : "none";
    }
  }

  function updateConvergenceBar() {
    var track = $id("convergence-track");
    var roundsLabel = $id("convergence-rounds");
    if (!track) return;

    track.innerHTML = "";

    // Build one segment per message
    var messages = state.currentMessages;
    var maxRounds = (state.currentMeta && state.currentMeta.config)
      ? state.currentMeta.config.guardrailRounds
      : 5;

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var seg = document.createElement("div");
      seg.className = "convergence-segment";

      // Color by convergence signal
      if (msg.convergenceSignal) {
        seg.classList.add(msg.convergenceSignal);
      } else {
        seg.classList.add("pending");
      }

      track.appendChild(seg);
    }

    // Pad remaining segments
    var remaining = maxRounds * 2 - messages.length; // 2 messages per round
    for (var r = 0; r < remaining && r < 20; r++) {
      var empty = document.createElement("div");
      empty.className = "convergence-segment pending";
      track.appendChild(empty);
    }

    if (roundsLabel) {
      // Show actual turn count
      var lastTurn = messages.length > 0 ? messages[messages.length - 1].turn : 0;
      roundsLabel.textContent = lastTurn + " / " + maxRounds + " rounds";
    }
  }

  // ── Message Rendering ──────────────────────────────────────────────

  function renderMessage(msg) {
    // Consensus messages get a distinct full-width layout
    if (msg.type === "consensus") {
      return renderConsensusMessage(msg);
    }

    var div = document.createElement("div");
    div.className = "message";

    var agentClass = msg.agent === "claude" ? "claude" : "codex";
    var agentInitial = msg.agent === "claude" ? "C" : "Cx";
    var agentLabel = msg.agent === "claude" ? "Claude" : "Codex";

    // Avatar
    var avatar = document.createElement("div");
    avatar.className = "message-avatar " + agentClass;
    avatar.textContent = agentInitial;

    // Body
    var body = document.createElement("div");
    body.className = "message-body";

    // Header
    var header = document.createElement("div");
    header.className = "message-header";

    var nameSpan = document.createElement("span");
    nameSpan.className = "agent-name " + agentClass;
    nameSpan.textContent = agentLabel;

    var roleSpan = document.createElement("span");
    roleSpan.className = "role-pill";
    roleSpan.textContent = msg.role || "";

    var turnSpan = document.createElement("span");
    turnSpan.className = "turn-number";
    turnSpan.textContent = "turn " + (msg.turn || 0);

    header.appendChild(nameSpan);
    header.appendChild(roleSpan);
    header.appendChild(turnSpan);

    // Signal badge
    if (msg.convergenceSignal) {
      var signal = document.createElement("span");
      signal.className = "signal-badge " + msg.convergenceSignal;
      signal.textContent = msg.convergenceSignal;
      header.appendChild(signal);
    }

    body.appendChild(header);

    // Content
    var content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = parseContent(msg.content);
    body.appendChild(content);

    // Artifacts
    if (msg.artifacts && msg.artifacts.length > 0) {
      var artifactsDiv = document.createElement("div");
      artifactsDiv.className = "message-artifacts";
      artifactsDiv.style.cssText = "margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;";

      for (var i = 0; i < msg.artifacts.length; i++) {
        var art = msg.artifacts[i];
        var tag = document.createElement("span");
        tag.style.cssText = "font-size:10px;padding:2px 8px;border-radius:3px;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-muted);";
        tag.textContent = (art.type || "file") + ": " + (art.path || "unnamed");
        artifactsDiv.appendChild(tag);
      }

      body.appendChild(artifactsDiv);
    }

    div.appendChild(avatar);
    div.appendChild(body);
    return div;
  }

  function renderConsensusMessage(msg) {
    var div = document.createElement("div");
    div.className = "message consensus";

    // Header
    var header = document.createElement("div");
    header.className = "consensus-header";
    header.textContent = "Final Answer";
    div.appendChild(header);

    // Content
    var content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = parseContent(msg.content);
    div.appendChild(content);

    return div;
  }

  // ── New Debate ─────────────────────────────────────────────────────

  function openNewDebateForm() {
    showView("new-debate-form");
    var input = $id("prompt-input");
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  function startDebate() {
    var promptInput = $id("prompt-input");
    var startWith = $id("config-start-with");
    var guardrail = $id("config-guardrail");
    var timeout = $id("config-timeout");

    var prompt = promptInput ? promptInput.value.trim() : "";
    if (!prompt) {
      if (promptInput) promptInput.focus();
      return;
    }

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.error("[topg] WebSocket not connected");
      return;
    }

    state.ws.send(JSON.stringify({
      type: "debate.start",
      prompt: prompt,
      config: {
        startWith: startWith ? startWith.value : "claude",
        guardrailRounds: guardrail ? parseInt(guardrail.value, 10) : 5,
        timeoutMs: timeout ? parseInt(timeout.value, 10) * 1000 : 900000,
      },
    }));

    // The server will reply with debate.started containing the sessionId,
    // which triggers selectSession() to show the live debate viewer.
  }

  // ── Guidance ───────────────────────────────────────────────────────

  function sendGuidance() {
    var input = $id("guidance-input");
    var guidance = input ? input.value.trim() : "";
    if (!guidance) return;

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.error("[topg] WebSocket not connected");
      return;
    }

    state.ws.send(JSON.stringify({
      type: "debate.steer",
      sessionId: state.currentSessionId,
      guidance: guidance,
    }));

    // Clear input and show typing
    if (input) input.value = "";
    var indicator = $id("typing-indicator");
    var label = $id("typing-label");
    if (indicator) indicator.style.display = "";
    if (label) label.textContent = "Processing guidance...";

    // Hide guidance bar and outcome bar since debate is resuming
    var guidanceBar = $id("guidance-bar");
    if (guidanceBar) guidanceBar.style.display = "none";
    var outcomeBar = $id("outcome-bar");
    if (outcomeBar) outcomeBar.style.display = "none";
  }

  // ── Pause / Resume ────────────────────────────────────────────────

  function pauseDebate() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: "debate.pause",
      sessionId: state.currentSessionId,
    }));
  }

  function resumeDebate() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: "debate.resume",
      sessionId: state.currentSessionId,
    }));
  }

  // ── Event Bindings ─────────────────────────────────────────────────

  function init() {
    // New debate button
    var newDebateBtn = $id("new-debate-btn");
    if (newDebateBtn) {
      newDebateBtn.addEventListener("click", openNewDebateForm);
    }

    // Start debate button
    var startBtn = $id("start-debate-btn");
    if (startBtn) {
      startBtn.addEventListener("click", startDebate);
    }

    // Guidance send
    var guidanceSend = $id("guidance-send");
    if (guidanceSend) {
      guidanceSend.addEventListener("click", sendGuidance);
    }

    // Pause / Resume
    var pauseBtn = $id("pause-btn");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", pauseDebate);
    }

    var resumeBtn = $id("resume-btn");
    if (resumeBtn) {
      resumeBtn.addEventListener("click", resumeDebate);
    }

    // Keyboard shortcut: N to open new debate (when not in input)
    document.addEventListener("keydown", function (e) {
      if (e.key === "n" || e.key === "N") {
        var tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
        if (tag !== "input" && tag !== "textarea" && tag !== "select") {
          e.preventDefault();
          openNewDebateForm();
        }
      }
    });

    // Connect WebSocket
    connectWs();
  }

  // ── Boot ───────────────────────────────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
