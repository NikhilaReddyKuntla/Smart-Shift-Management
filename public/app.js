const state = {
  token: localStorage.getItem("bu_shift_token") || "",
  user: null,
  users: [],
  shifts: [],
  dashboard: null,
  pending: null,
  availability: [],
  activeSection: "overview",
  activeConversation: {
    channelType: "group",
    peerId: null,
    threadId: null,
  },
  groupMessagesCache: [],
  dmMessagesCache: [],
  shiftThreadCache: {},
};

const navConfigByRole = {
  manager: [
    { id: "overview", label: "Overview", subtitle: "Staffing health, no-show risk, and confirmation status." },
    { id: "shifts", label: "Shifts", subtitle: "Publish upcoming shifts and record attendance outcomes." },
    { id: "requests", label: "Requests", subtitle: "Approve or reject student swap and drop requests." },
    { id: "messages", label: "Messages", subtitle: "Coordinate staffing updates through group, DM, and shift threads." },
    { id: "settings", label: "Settings", subtitle: "Run reminder jobs and manage operations controls." },
  ],
  student: [
    { id: "overview", label: "Overview", subtitle: "Track confirmations and key shift notifications." },
    { id: "shifts", label: "Shifts", subtitle: "Claim open shifts and manage your upcoming assignments." },
    { id: "requests", label: "Requests", subtitle: "Review your swap and drop request history." },
    { id: "availability", label: "Availability", subtitle: "Maintain your 30-minute class busy-slot schedule." },
    { id: "messages", label: "Messages", subtitle: "Chat with the team, manager, or shift-specific thread." },
    { id: "settings", label: "Settings", subtitle: "Update personal notification preferences." },
  ],
};

const el = {
  heroBanner: document.getElementById("heroBanner"),
  loginPanel: document.getElementById("loginPanel"),
  appPanel: document.getElementById("appPanel"),
  manualLoginForm: document.getElementById("manualLoginForm"),
  emailInput: document.getElementById("emailInput"),
  passwordInput: document.getElementById("passwordInput"),
  welcomeText: document.getElementById("welcomeText"),
  roleText: document.getElementById("roleText"),
  logoutBtn: document.getElementById("logoutBtn"),
  errorBox: document.getElementById("errorBox"),
  navMenu: document.getElementById("navMenu"),
  sectionTitle: document.getElementById("sectionTitle"),
  sectionSubtitle: document.getElementById("sectionSubtitle"),
  managerOverview: document.getElementById("managerOverview"),
  studentOverview: document.getElementById("studentOverview"),
  managerShifts: document.getElementById("managerShifts"),
  studentShifts: document.getElementById("studentShifts"),
  managerRequests: document.getElementById("managerRequests"),
  studentRequestsPanel: document.getElementById("studentRequestsPanel"),
  studentAvailabilityPanel: document.getElementById("studentAvailabilityPanel"),
  managerAvailabilityPanel: document.getElementById("managerAvailabilityPanel"),
  managerSettings: document.getElementById("managerSettings"),
  studentSettings: document.getElementById("studentSettings"),
  managerMetrics: document.getElementById("managerMetrics"),
  managerPendingConfirmations: document.getElementById("managerPendingConfirmations"),
  createShiftForm: document.getElementById("createShiftForm"),
  pendingSwaps: document.getElementById("pendingSwaps"),
  pendingDrops: document.getElementById("pendingDrops"),
  noShowRisk: document.getElementById("noShowRisk"),
  attendanceList: document.getElementById("attendanceList"),
  runReminderBtn: document.getElementById("runReminderBtn"),
  reminderResult: document.getElementById("reminderResult"),
  confirmationTasks: document.getElementById("confirmationTasks"),
  claimableShifts: document.getElementById("claimableShifts"),
  upcomingShifts: document.getElementById("upcomingShifts"),
  studentRequests: document.getElementById("studentRequests"),
  studentNotifications: document.getElementById("studentNotifications"),
  smsToggle: document.getElementById("smsToggle"),
  availabilityGrid: document.getElementById("availabilityGrid"),
  saveAvailabilityBtn: document.getElementById("saveAvailabilityBtn"),
  availabilityResult: document.getElementById("availabilityResult"),
  pmUserSelect: document.getElementById("pmUserSelect"),
  startPmBtn: document.getElementById("startPmBtn"),
  channelList: document.getElementById("channelList"),
  dmList: document.getElementById("dmList"),
  shiftThreadList: document.getElementById("shiftThreadList"),
  chatTitle: document.getElementById("chatTitle"),
  chatSubtitle: document.getElementById("chatSubtitle"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  refreshMessagesBtn: document.getElementById("refreshMessagesBtn"),
  messageFeed: document.getElementById("messageFeed"),
  viewSections: Array.from(document.querySelectorAll(".view-section")),
};

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const halfHourSlots = Array.from({ length: 48 }, (_, idx) => {
  const hh = String(Math.floor(idx / 2)).padStart(2, "0");
  const mm = idx % 2 === 0 ? "00" : "30";
  return `${hh}:${mm}`;
});
const LOCAL_GROUP_MESSAGES_KEY = "bu_shift_group_messages_v1";
const MESSAGE_POLL_MS = 8000;
let messagePollTimer = null;

function setVisible(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function showError(message) {
  if (!message) {
    el.errorBox.classList.add("hidden");
    el.errorBox.textContent = "";
    return;
  }
  el.errorBox.textContent = message;
  el.errorBox.classList.remove("hidden");
}

function prettyDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getLocalGroupMessages() {
  try {
    const raw = localStorage.getItem(LOCAL_GROUP_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function setLocalGroupMessages(messages) {
  localStorage.setItem(LOCAL_GROUP_MESSAGES_KEY, JSON.stringify(messages.slice(0, 500)));
}

function mergeMessages(primary, secondary) {
  const seen = new Set();
  const merged = [];
  for (const message of [...primary, ...secondary]) {
    const key = message.id || `${message.channelType}|${message.senderId}|${message.sentAt}|${message.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
}

function startMessagePolling() {
  if (messagePollTimer || !state.user) return;
  messagePollTimer = setInterval(async () => {
    try {
      await refreshMessages();
    } catch (_error) {
      // Keep background refresh non-blocking.
    }
  }, MESSAGE_POLL_MS);
}

function stopMessagePolling() {
  if (!messagePollTimer) return;
  clearInterval(messagePollTimer);
  messagePollTimer = null;
}

function setAuthLayout(isAuthenticated) {
  document.body.classList.toggle("signed-in", isAuthenticated);
  document.body.classList.toggle("signed-out", !isAuthenticated);
  setVisible(el.heroBanner, !isAuthenticated);
  setVisible(el.loginPanel, !isAuthenticated);
  setVisible(el.appPanel, isAuthenticated);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) {
    headers["x-user-id"] = state.token;
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Request failed (${response.status})`);
  }
  return data;
}

function userLabel(user) {
  return `${user.name} (${user.role})`;
}

function setAuthToken(token) {
  state.token = token;
  if (token) {
    localStorage.setItem("bu_shift_token", token);
  } else {
    localStorage.removeItem("bu_shift_token");
  }
}

function allowedSections() {
  if (!state.user) return [];
  return navConfigByRole[state.user.role] || [];
}

function ensureValidSection(sectionId) {
  const allowed = allowedSections();
  if (allowed.some((item) => item.id === sectionId)) {
    return sectionId;
  }
  return allowed[0]?.id || "overview";
}

function renderNav() {
  const allowed = allowedSections();
  el.navMenu.innerHTML = allowed
    .map(
      (item) => `
      <button class="nav-btn ${state.activeSection === item.id ? "active" : ""}" data-section="${item.id}">
        ${item.label}
      </button>
    `,
    )
    .join("");
}

function setActiveSection(sectionId) {
  state.activeSection = ensureValidSection(sectionId);
  renderNav();

  el.viewSections.forEach((section) => {
    section.classList.toggle("active", section.id === `view-${state.activeSection}`);
  });

  const current = allowedSections().find((item) => item.id === state.activeSection);
  el.sectionTitle.textContent = current?.label || "Overview";
  el.sectionSubtitle.textContent = current?.subtitle || "";
}

function renderManagerMetrics(metrics) {
  const items = [
    ["Open Shifts", metrics.openShiftCount],
    ["Confirmations Pending", metrics.confirmationsPendingCount],
    ["No-show Risk", metrics.noShowRiskCount],
    ["Recorded No-shows", metrics.noShowCount],
    ["No-show Rate", `${Math.round(metrics.noShowRate * 100)}%`],
  ];

  el.managerMetrics.innerHTML = items
    .map(
      ([label, value]) => `
      <div class="metric">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>
    `,
    )
    .join("");
}

function renderList(container, items, renderer, emptyLabel) {
  if (!items || items.length === 0) {
    container.innerHTML = `<p class="hint">${emptyLabel}</p>`;
    return;
  }
  container.innerHTML = `<div class="list">${items.map(renderer).join("")}</div>`;
}

function getShiftById(shiftId) {
  return state.shifts.find((shift) => shift.id === shiftId);
}

function getUserName(userId) {
  const user = state.users.find((entry) => entry.id === userId);
  return user ? user.name : userId || "Unknown";
}

function renderManagerView() {
  const dashboard = state.dashboard;
  renderManagerMetrics(dashboard.metrics);

  renderList(
    el.noShowRisk,
    dashboard.noShowRisk,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} · Assigned: ${shift.assignedUserName || shift.assignedUserId || "Unknown"}</div>
        <div class="item-meta">Confirmation due: ${prettyDate(shift.confirmationDueAt)}</div>
      </div>
    `,
    "No immediate no-show risks.",
  );

  renderList(
    el.managerPendingConfirmations,
    dashboard.confirmationsPending,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} · Student: ${shift.assignedUserName || shift.assignedUserId}</div>
        <div class="item-meta">Due: ${prettyDate(shift.confirmationDueAt)}</div>
      </div>
    `,
    "No pending confirmations.",
  );

  renderList(
    el.pendingSwaps,
    dashboard.pendingSwapRequests,
    (request) => {
      const shift = getShiftById(request.shiftId);
      const requesterName = getUserName(request.requesterId);
      const candidateName = getUserName(request.candidateId);
      const shiftLabel = shift ? `${shift.roleNeeded} · ${shift.location}` : request.shiftId;
      const shiftTime = shift ? `${prettyDate(shift.startAt)} - ${prettyDate(shift.endAt)}` : "Shift details unavailable";
      return `
        <div class="list-item">
          <div class="item-title">${shiftLabel}</div>
          <div class="item-meta">Requested by: ${requesterName}</div>
          <div class="item-meta">Requested swap with: ${candidateName}</div>
          <div class="item-meta">Current assignment: ${getUserName(shift?.assignedUserId || request.requesterId)}</div>
          <div class="item-meta">Shift time: ${shiftTime}</div>
          <div class="item-meta">Requested on: ${prettyDate(request.createdAt)}</div>
          <div class="item-actions">
            <button data-swap-decision="approve" data-request-id="${request.id}">Approve</button>
            <button class="danger" data-swap-decision="reject" data-request-id="${request.id}">Reject</button>
          </div>
        </div>
      `;
    },
    "No swap approvals pending.",
  );

  renderList(
    el.pendingDrops,
    dashboard.pendingDropRequests,
    (request) => {
      const shift = getShiftById(request.shiftId);
      const requesterName = getUserName(request.requesterId);
      const shiftLabel = shift ? `${shift.roleNeeded} · ${shift.location}` : request.shiftId;
      const shiftTime = shift ? `${prettyDate(shift.startAt)} - ${prettyDate(shift.endAt)}` : "Shift details unavailable";
      return `
        <div class="list-item">
          <div class="item-title">${shiftLabel}</div>
          <div class="item-meta">Requested by: ${requesterName}</div>
          <div class="item-meta">Current assignment: ${getUserName(shift?.assignedUserId || request.requesterId)}</div>
          <div class="item-meta">Shift time: ${shiftTime}</div>
          <div class="item-meta">Requested on: ${prettyDate(request.createdAt)}</div>
          <div class="item-actions">
            <button data-drop-decision="approve" data-request-id="${request.id}">Approve</button>
            <button class="danger" data-drop-decision="reject" data-request-id="${request.id}">Reject</button>
          </div>
        </div>
      `;
    },
    "No drop approvals pending.",
  );

  const attendanceCandidates = state.shifts.filter((shift) => shift.assignedUserId);
  renderList(
    el.attendanceList,
    attendanceCandidates,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} · Student: ${shift.assignedUserName || shift.assignedUserId}</div>
        <div class="item-actions">
          <button data-attendance-mark="present" data-shift-id="${shift.id}">Present</button>
          <button class="danger" data-attendance-mark="no_show" data-shift-id="${shift.id}">No-show</button>
          <button data-attendance-mark="excused" data-shift-id="${shift.id}">Excused</button>
        </div>
      </div>
    `,
    "No assigned shifts to mark yet.",
  );
}

function renderStudentView() {
  const dashboard = state.dashboard;
  const students = state.users.filter((user) => user.role === "student" && user.id !== state.user.id);

  el.smsToggle.checked = Boolean(state.user.notificationPrefs?.smsOptIn);

  renderList(
    el.confirmationTasks,
    dashboard.confirmationTasks,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)}</div>
        <div class="item-meta">Confirm by: ${prettyDate(shift.confirmationDueAt)}</div>
        <div class="item-actions"><button data-confirm-shift="${shift.id}">Confirm Shift</button></div>
      </div>
    `,
    "No confirmation tasks pending.",
  );

  renderList(
    el.studentNotifications,
    dashboard.notifications,
    (note) => `
      <div class="list-item">
        <div class="item-title">${note.subject}</div>
        <div class="item-meta">${note.body}</div>
        <div class="item-meta">${prettyDate(note.createdAt)}</div>
      </div>
    `,
    "No notifications yet.",
  );

  renderList(
    el.claimableShifts,
    dashboard.claimableShifts,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} - ${prettyDate(shift.endAt)}</div>
        <div class="item-actions"><button data-claim-shift="${shift.id}">Claim Shift</button></div>
      </div>
    `,
    "No claimable shifts at the moment.",
  );

  renderList(
    el.upcomingShifts,
    dashboard.upcomingShifts,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} · ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} - ${prettyDate(shift.endAt)}</div>
        <div class="item-meta">Confirmed: ${shift.confirmedAt ? "Yes" : "No"}</div>
        <div class="item-actions">
          <select id="swap-candidate-${shift.id}">
            <option value="">Select swap candidate</option>
            ${students.map((s) => `<option value="${s.id}">${s.name}</option>`).join("")}
          </select>
          <button data-request-swap="${shift.id}">Request Swap</button>
          <button class="danger" data-request-drop="${shift.id}">Request Drop</button>
        </div>
      </div>
    `,
    "No upcoming shifts assigned.",
  );

  const swapItems = dashboard.requestHistory.swapRequests.map(
    (request) => `<div class="list-item"><div class="item-title">Swap ${request.shiftId}</div><div class="item-meta">Status: ${request.status}</div></div>`,
  );
  const dropItems = dashboard.requestHistory.dropRequests.map(
    (request) => `<div class="list-item"><div class="item-title">Drop ${request.shiftId}</div><div class="item-meta">Status: ${request.status}</div></div>`,
  );
  const requestItems = [...swapItems, ...dropItems];
  el.studentRequests.innerHTML = requestItems.length > 0 ? `<div class="list">${requestItems.join("")}</div>` : `<p class="hint">No swap/drop requests yet.</p>`;
}

function renderAvailabilityGrid(slots) {
  const selected = new Set(slots.map((slot) => `${slot.dayOfWeek}|${slot.startTime}`));
  const head = `<tr><th>Time</th>${days.map((day, index) => `<th>${day}<br/><small>${index}</small></th>`).join("")}</tr>`;
  const rows = halfHourSlots
    .map((time) => {
      const cells = days
        .map((_, dayIdx) => {
          const key = `${dayIdx}|${time}`;
          const checked = selected.has(key) ? "checked" : "";
          return `<td><input type="checkbox" data-day="${dayIdx}" data-start="${time}" ${checked} /></td>`;
        })
        .join("");
      return `<tr><td>${time}</td>${cells}</tr>`;
    })
    .join("");
  el.availabilityGrid.innerHTML = `${head}${rows}`;
}

function applyRolePanels() {
  const isManager = state.user?.role === "manager";

  setVisible(el.managerOverview, isManager);
  setVisible(el.studentOverview, !isManager);
  setVisible(el.managerShifts, isManager);
  setVisible(el.studentShifts, !isManager);
  setVisible(el.managerRequests, isManager);
  setVisible(el.studentRequestsPanel, !isManager);
  setVisible(el.managerAvailabilityPanel, isManager);
  setVisible(el.studentAvailabilityPanel, !isManager);
  setVisible(el.managerSettings, isManager);
  setVisible(el.studentSettings, !isManager);
}

function getAllowedDmPeers() {
  const users = state.users.filter((user) => user.id !== state.user?.id);
  return users.filter((candidate) => {
    if (state.user?.role === "manager") return candidate.role === "student";
    return candidate.role === "student" || candidate.role === "manager";
  });
}

function getShiftThreadCandidates() {
  if (!state.user) return [];
  if (state.user.role === "manager") {
    return [...state.shifts].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  }
  return state.shifts
    .filter((shift) => shift.assignedUserId === state.user.id)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

function conversationKey(conversation) {
  if (conversation.channelType === "dm") return `dm:${conversation.peerId || "none"}`;
  if (conversation.channelType === "shift_thread") return `shift:${conversation.threadId || "none"}`;
  return "group:department-main";
}

function sameConversation(a, b) {
  return conversationKey(a) === conversationKey(b);
}

function normalizeConversation(candidate) {
  const base = {
    channelType: candidate?.channelType || "group",
    peerId: candidate?.peerId || null,
    threadId: candidate?.threadId || null,
  };

  if (base.channelType === "dm") {
    if (base.peerId) return base;
    const firstPeer = getAllowedDmPeers()[0];
    return firstPeer ? { channelType: "dm", peerId: firstPeer.id, threadId: null } : { channelType: "group", peerId: null, threadId: null };
  }

  if (base.channelType === "shift_thread") {
    if (base.threadId) return base;
    const firstThread = getShiftThreadCandidates()[0];
    return firstThread ? { channelType: "shift_thread", peerId: null, threadId: firstThread.id } : { channelType: "group", peerId: null, threadId: null };
  }

  return { channelType: "group", peerId: null, threadId: null };
}

function getUserByIdLocal(id) {
  return state.users.find((user) => user.id === id) || null;
}

function extractDmPeerIdFromThread(threadId) {
  const ids = String(threadId || "").split("__");
  return ids.find((id) => id && id !== state.user?.id) || null;
}

function shortTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

async function fetchGroupMessages() {
  const data = await api("/api/messages?channelType=group");
  const merged = mergeMessages(data.messages || [], getLocalGroupMessages());
  state.groupMessagesCache = merged;
  setLocalGroupMessages(merged);
}

async function fetchDmMessages() {
  const data = await api("/api/messages?channelType=dm");
  state.dmMessagesCache = data.messages || [];
}

async function fetchShiftThreadMessages(threadId) {
  if (!threadId) return;
  const data = await api(`/api/messages?channelType=shift_thread&threadId=${encodeURIComponent(threadId)}`);
  state.shiftThreadCache[threadId] = data.messages || [];
}

function getConversationTitle(conversation) {
  if (conversation.channelType === "group") return "Department Group";
  if (conversation.channelType === "dm") {
    const peer = getUserByIdLocal(conversation.peerId);
    return peer ? peer.name : "Private Message";
  }
  const shift = state.shifts.find((entry) => entry.id === conversation.threadId);
  return shift ? `${shift.roleNeeded} · ${shift.location}` : "Shift Thread";
}

function getConversationSubtitle(conversation) {
  if (conversation.channelType === "group") return "Conversation for all staffing updates.";
  if (conversation.channelType === "dm") {
    const peer = getUserByIdLocal(conversation.peerId);
    return peer ? `Private chat with ${peer.name} (${peer.role})` : "Private chat";
  }
  const shift = state.shifts.find((entry) => entry.id === conversation.threadId);
  return shift ? `Shift starts ${prettyDate(shift.startAt)}` : "Discuss swap, drop, and shift details.";
}

function buildDmLatestMap() {
  const map = new Map();
  for (const message of state.dmMessagesCache) {
    const peerId = extractDmPeerIdFromThread(message.threadId);
    if (!peerId) continue;
    const existing = map.get(peerId);
    if (!existing || new Date(message.sentAt) > new Date(existing.sentAt)) {
      map.set(peerId, message);
    }
  }
  return map;
}

function renderConversationItems(container, items, emptyLabel) {
  if (!items.length) {
    container.innerHTML = `<p class="hint">${emptyLabel}</p>`;
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const activeClass = item.active ? "active" : "";
      const timeMarkup = item.time ? `<span class="conversation-time">${item.time}</span>` : "";
      return `
        <button type="button" class="conversation-item ${activeClass}" data-conv-channel="${item.channelType}" data-conv-peer="${item.peerId || ""}" data-conv-thread="${item.threadId || ""}">
          <div class="conversation-top">
            <span class="conversation-name">${item.name}</span>
            ${timeMarkup}
          </div>
          <div class="conversation-preview">${item.preview}</div>
        </button>
      `;
    })
    .join("");
}

function renderConversationLists() {
  const dmLatest = buildDmLatestMap();
  const groupLatest = state.groupMessagesCache[0] || null;

  renderConversationItems(
    el.channelList,
    [
      {
        channelType: "group",
        peerId: null,
        threadId: null,
        name: "Department Group",
        preview: groupLatest ? `${getUserByIdLocal(groupLatest.senderId)?.name || "Unknown"}: ${groupLatest.body}` : "No messages yet",
        time: groupLatest ? shortTime(groupLatest.sentAt) : "",
        active: sameConversation(state.activeConversation, { channelType: "group", peerId: null, threadId: null }),
      },
    ],
    "No channels yet.",
  );

  const dmItems = getAllowedDmPeers()
    .map((peer) => {
      const latest = dmLatest.get(peer.id) || null;
      return {
        channelType: "dm",
        peerId: peer.id,
        threadId: null,
        name: peer.name,
        preview: latest ? latest.body : "Start a private message",
        time: latest ? shortTime(latest.sentAt) : "",
        active: sameConversation(state.activeConversation, { channelType: "dm", peerId: peer.id, threadId: null }),
        sortKey: latest ? new Date(latest.sentAt).getTime() : 0,
      };
    })
    .sort((a, b) => {
      if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
      return a.name.localeCompare(b.name);
    });

  renderConversationItems(el.dmList, dmItems, "No direct message peers available.");

  const shiftItems = getShiftThreadCandidates().map((shift) => {
    const latest = (state.shiftThreadCache[shift.id] || [])[0] || null;
    return {
      channelType: "shift_thread",
      peerId: null,
      threadId: shift.id,
      name: `${shift.roleNeeded} · ${shift.location}`,
      preview: latest ? latest.body : `Starts ${prettyDate(shift.startAt)}`,
      time: latest ? shortTime(latest.sentAt) : "",
      active: sameConversation(state.activeConversation, { channelType: "shift_thread", peerId: null, threadId: shift.id }),
    };
  });

  renderConversationItems(el.shiftThreadList, shiftItems, "No shift threads yet.");

  el.pmUserSelect.innerHTML = getAllowedDmPeers().map((peer) => `<option value="${peer.id}">${peer.name} (${peer.role})</option>`).join("");
}

function getActiveConversationMessages() {
  if (state.activeConversation.channelType === "group") {
    return state.groupMessagesCache;
  }
  if (state.activeConversation.channelType === "dm") {
    return state.dmMessagesCache.filter((message) => extractDmPeerIdFromThread(message.threadId) === state.activeConversation.peerId);
  }
  return state.shiftThreadCache[state.activeConversation.threadId] || [];
}

function renderChatHeader() {
  el.chatTitle.textContent = getConversationTitle(state.activeConversation);
  el.chatSubtitle.textContent = getConversationSubtitle(state.activeConversation);

  if (state.activeConversation.channelType === "dm") {
    el.messageInput.placeholder = "Write a private message...";
  } else if (state.activeConversation.channelType === "shift_thread") {
    el.messageInput.placeholder = "Write in this shift thread...";
  } else {
    el.messageInput.placeholder = "Write a message to the group...";
  }
}

function renderChatMessages(messages) {
  const sorted = [...messages].sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
  if (!sorted.length) {
    el.messageFeed.innerHTML = `<div class="chat-placeholder">No messages yet. Start the conversation.</div>`;
    return;
  }

  el.messageFeed.innerHTML = sorted
    .map((message) => {
      const mine = message.senderId === state.user?.id;
      const sender = getUserByIdLocal(message.senderId);
      const author = mine ? "You" : sender?.name || "Unknown";
      return `
        <div class="chat-row ${mine ? "mine" : "theirs"}">
          <div class="chat-bubble">
            <div class="bubble-meta">
              <span class="bubble-author">${author}</span>
              <span class="bubble-time">${shortTime(message.sentAt)}</span>
            </div>
            <div class="bubble-text">${message.body}</div>
          </div>
        </div>
      `;
    })
    .join("");

  el.messageFeed.scrollTop = el.messageFeed.scrollHeight;
}

async function openConversation(conversation) {
  state.activeConversation = normalizeConversation(conversation);
  await refreshMessages();
}

async function refreshMessages() {
  await Promise.all([fetchGroupMessages(), fetchDmMessages()]);

  if (state.activeConversation.channelType === "shift_thread") {
    await fetchShiftThreadMessages(state.activeConversation.threadId);
  }

  state.activeConversation = normalizeConversation(state.activeConversation);
  renderConversationLists();
  renderChatHeader();
  renderChatMessages(getActiveConversationMessages());
}
async function refreshDashboard() {
  showError("");
  const [meRes, shiftsRes] = await Promise.all([api("/api/me"), api("/api/shifts")]);
  state.user = meRes.user;
  state.shifts = shiftsRes.shifts;

  el.welcomeText.textContent = state.user.name;
  el.roleText.textContent = `Role: ${state.user.role}`;

  applyRolePanels();

  if (state.user.role === "manager") {
    const [dashboard, pending] = await Promise.all([api("/api/dashboard/manager"), api("/api/requests/pending")]);
    state.dashboard = dashboard;
    state.pending = pending;
    renderManagerView();
  } else {
    const [dashboard, availability] = await Promise.all([api("/api/dashboard/student"), api("/api/availability")]);
    state.dashboard = dashboard;
    state.availability = availability.slots;
    renderStudentView();
    renderAvailabilityGrid(availability.slots);
  }

  state.activeConversation = normalizeConversation(state.activeConversation);
  renderNav();
  setActiveSection(state.activeSection);
  await refreshMessages();
}

async function login(email, password) {
  const { token } = await api("/api/auth/login", {
    method: "POST",
    body: { email, password },
    headers: {},
  });

  setAuthToken(token);
  state.activeSection = "overview";
  state.activeConversation = { channelType: "group", peerId: null, threadId: null };
  state.groupMessagesCache = [];
  state.dmMessagesCache = [];
  state.shiftThreadCache = {};
  setAuthLayout(true);

  await refreshDashboard();
  startMessagePolling();
}

function logout() {
  stopMessagePolling();
  setAuthToken("");
  state.user = null;
  state.dashboard = null;
  state.shifts = [];
  state.groupMessagesCache = [];
  state.dmMessagesCache = [];
  state.shiftThreadCache = {};
  state.activeConversation = { channelType: "group", peerId: null, threadId: null };
  el.messageFeed.innerHTML = "";
  setAuthLayout(false);
}

async function bootstrap() {
  setAuthLayout(Boolean(state.token));
  try {
    const data = await api("/api/users", { headers: {}, body: undefined });
    state.users = data.users;

    if (state.token) {
      await refreshDashboard();
      startMessagePolling();
    }
  } catch (error) {
    stopMessagePolling();
    setAuthToken("");
    setAuthLayout(false);
    showError(error.message);
  }
}

el.navMenu.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-section]");
  if (!btn) return;
  setActiveSection(btn.dataset.section);
});

el.manualLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await login(el.emailInput.value, el.passwordInput.value);
  } catch (error) {
    showError(error.message);
  }
});

el.logoutBtn.addEventListener("click", logout);

el.createShiftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(el.createShiftForm);
    const startAt = new Date(form.get("startAt"));
    const endAt = new Date(form.get("endAt"));

    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new Error("Please provide valid start and end times.");
    }

    await api("/api/shifts", {
      method: "POST",
      body: {
        roleNeeded: form.get("roleNeeded"),
        location: form.get("location"),
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      },
    });

    el.createShiftForm.reset();
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.pendingSwaps.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-swap-decision]");
  if (!btn) return;
  try {
    await api(`/api/swaps/${btn.dataset.requestId}/decision`, {
      method: "POST",
      body: { decision: btn.dataset.swapDecision },
    });
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.pendingDrops.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-drop-decision]");
  if (!btn) return;
  try {
    await api(`/api/drops/${btn.dataset.requestId}/decision`, {
      method: "POST",
      body: { decision: btn.dataset.dropDecision },
    });
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.attendanceList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-attendance-mark]");
  if (!btn) return;
  try {
    const shift = getShiftById(btn.dataset.shiftId);
    await api("/api/attendance", {
      method: "POST",
      body: {
        shiftId: btn.dataset.shiftId,
        studentId: shift?.assignedUserId,
        mark: btn.dataset.attendanceMark,
      },
    });
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.runReminderBtn.addEventListener("click", async () => {
  try {
    const result = await api("/api/reminders/run", {
      method: "POST",
      body: {},
    });
    el.reminderResult.textContent = `Reminders sent: ${result.remindersSent}`;
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.confirmationTasks.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-confirm-shift]");
  if (!btn) return;
  try {
    await api(`/api/shifts/${btn.dataset.confirmShift}/confirm`, {
      method: "POST",
      body: {},
    });
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.claimableShifts.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-claim-shift]");
  if (!btn) return;
  try {
    await api(`/api/shifts/${btn.dataset.claimShift}/claim`, {
      method: "POST",
      body: {},
    });
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.upcomingShifts.addEventListener("click", async (event) => {
  const swapBtn = event.target.closest("button[data-request-swap]");
  const dropBtn = event.target.closest("button[data-request-drop]");

  try {
    if (swapBtn) {
      const shiftId = swapBtn.dataset.requestSwap;
      const candidateInput = document.getElementById(`swap-candidate-${shiftId}`);
      const candidateId = candidateInput?.value;
      if (!candidateId) {
        throw new Error("Select a swap candidate first.");
      }

      await api("/api/swaps", {
        method: "POST",
        body: { shiftId, candidateId },
      });
      await refreshDashboard();
    }

    if (dropBtn) {
      await api("/api/drops", {
        method: "POST",
        body: { shiftId: dropBtn.dataset.requestDrop },
      });
      await refreshDashboard();
    }
  } catch (error) {
    showError(error.message);
  }
});

el.smsToggle.addEventListener("change", async () => {
  try {
    const result = await api("/api/me/notification-prefs", {
      method: "PATCH",
      body: { smsOptIn: el.smsToggle.checked },
    });
    state.user.notificationPrefs = result.notificationPrefs;
  } catch (error) {
    showError(error.message);
  }
});

el.saveAvailabilityBtn.addEventListener("click", async () => {
  try {
    const selectedSlots = [];
    el.availabilityGrid.querySelectorAll("input[type='checkbox']:checked").forEach((input) => {
      const dayOfWeek = Number(input.dataset.day);
      const startTime = input.dataset.start;
      const [h, m] = startTime.split(":").map(Number);
      const endMinutes = h * 60 + m + 30;
      const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
      selectedSlots.push({ dayOfWeek, startTime, endTime });
    });

    await api("/api/availability", {
      method: "PUT",
      body: { slots: selectedSlots },
    });

    el.availabilityResult.textContent = `Saved ${selectedSlots.length} busy slots.`;
    await refreshDashboard();
  } catch (error) {
    showError(error.message);
  }
});

el.channelList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-conv-channel]");
  if (!btn) return;
  try {
    await openConversation({ channelType: btn.dataset.convChannel, peerId: btn.dataset.convPeer || null, threadId: btn.dataset.convThread || null });
  } catch (error) {
    showError(error.message);
  }
});

el.dmList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-conv-channel]");
  if (!btn) return;
  try {
    await openConversation({ channelType: btn.dataset.convChannel, peerId: btn.dataset.convPeer || null, threadId: btn.dataset.convThread || null });
  } catch (error) {
    showError(error.message);
  }
});

el.shiftThreadList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-conv-channel]");
  if (!btn) return;
  try {
    await openConversation({ channelType: btn.dataset.convChannel, peerId: btn.dataset.convPeer || null, threadId: btn.dataset.convThread || null });
  } catch (error) {
    showError(error.message);
  }
});

el.startPmBtn.addEventListener("click", async () => {
  try {
    const peerId = el.pmUserSelect.value;
    if (!peerId) {
      throw new Error("Pick a user first to start PM.");
    }
    await openConversation({ channelType: "dm", peerId, threadId: null });
  } catch (error) {
    showError(error.message);
  }
});

el.refreshMessagesBtn.addEventListener("click", async () => {
  try {
    await refreshMessages();
  } catch (error) {
    showError(error.message);
  }
});

el.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const body = el.messageInput.value.trim();
    if (!body) {
      throw new Error("Message cannot be empty.");
    }

    const payload = {
      channelType: state.activeConversation.channelType,
      body,
    };

    if (state.activeConversation.channelType === "dm") {
      payload.recipientId = state.activeConversation.peerId;
    }
    if (state.activeConversation.channelType === "shift_thread") {
      payload.threadId = state.activeConversation.threadId;
    }

    const result = await api("/api/messages", {
      method: "POST",
      body: payload,
    });

    if (state.activeConversation.channelType === "group" && result.message) {
      state.groupMessagesCache = mergeMessages([result.message], state.groupMessagesCache);
      setLocalGroupMessages(mergeMessages([result.message], getLocalGroupMessages()));
    }

    if (state.activeConversation.channelType === "dm" && result.message) {
      state.dmMessagesCache = mergeMessages([result.message], state.dmMessagesCache);
    }

    if (state.activeConversation.channelType === "shift_thread" && result.message) {
      const threadId = state.activeConversation.threadId;
      state.shiftThreadCache[threadId] = mergeMessages([result.message], state.shiftThreadCache[threadId] || []);
    }

    el.messageInput.value = "";
    await refreshMessages();
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener("visibilitychange", () => {
  if (!state.user) return;
  if (document.hidden) {
    stopMessagePolling();
  } else {
    startMessagePolling();
  }
});

bootstrap();







