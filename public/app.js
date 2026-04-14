const state = {
  token: localStorage.getItem("bu_shift_token") || "",
  user: null,
  users: [],
  shifts: [],
  dashboard: null,
  pending: null,
  availability: [],
  activeSection: "overview",
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
  userCards: document.getElementById("userCards"),
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
  channelType: document.getElementById("channelType"),
  peerWrapper: document.getElementById("peerWrapper"),
  peerSelect: document.getElementById("peerSelect"),
  threadWrapper: document.getElementById("threadWrapper"),
  threadSelect: document.getElementById("threadSelect"),
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

function renderUserCards() {
  el.userCards.innerHTML = state.users
    .map(
      (user) => `
      <div class="user-card">
        <div class="item-title">${user.name}</div>
        <div class="item-meta">${user.role} � ${user.email}</div>
        <div class="item-meta">Demo password: <code>${user.demoPassword}</code></div>
        <div class="item-actions">
          <button data-login-email="${user.email}" data-login-password="${user.demoPassword}">Login as ${user.role}</button>
        </div>
      </div>
    `,
    )
    .join("");
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

function renderManagerView() {
  const dashboard = state.dashboard;
  renderManagerMetrics(dashboard.metrics);

  renderList(
    el.noShowRisk,
    dashboard.noShowRisk,
    (shift) => `
      <div class="list-item">
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} � Assigned: ${shift.assignedUserName || shift.assignedUserId || "Unknown"}</div>
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
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} � Student: ${shift.assignedUserName || shift.assignedUserId}</div>
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
      return `
        <div class="list-item">
          <div class="item-title">Shift ${request.shiftId}</div>
          <div class="item-meta">Requester: ${request.requesterId} � Candidate: ${request.candidateId}</div>
          <div class="item-meta">${shift ? `${prettyDate(shift.startAt)} at ${shift.location}` : ""}</div>
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
      return `
        <div class="list-item">
          <div class="item-title">Shift ${request.shiftId}</div>
          <div class="item-meta">Requester: ${request.requesterId}</div>
          <div class="item-meta">${shift ? `${prettyDate(shift.startAt)} at ${shift.location}` : ""}</div>
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
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
        <div class="item-meta">${prettyDate(shift.startAt)} � Student: ${shift.assignedUserName || shift.assignedUserId}</div>
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
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
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
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
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
        <div class="item-title">${shift.roleNeeded} � ${shift.location}</div>
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

function loadPeerAndThreadOptions() {
  const users = state.users.filter((user) => user.id !== state.user.id);
  const peers = users.filter((candidate) => {
    if (state.user.role === "manager") return candidate.role === "student";
    return candidate.role === "student" || candidate.role === "manager";
  });

  el.peerSelect.innerHTML = peers.map((user) => `<option value="${user.id}">${userLabel(user)}</option>`).join("");
  el.threadSelect.innerHTML = state.shifts.map((shift) => `<option value="${shift.id}">${shift.roleNeeded} � ${prettyDate(shift.startAt)}</option>`).join("");
}

function updateMessageControls() {
  const channelType = el.channelType.value;
  el.peerWrapper.classList.toggle("hidden", channelType !== "dm");
  el.threadWrapper.classList.toggle("hidden", channelType !== "shift_thread");
}

async function refreshMessages() {
  const channelType = el.channelType.value;
  let path = `/api/messages?channelType=${encodeURIComponent(channelType)}`;

  if (channelType === "dm" && el.peerSelect.value) {
    path += `&peerId=${encodeURIComponent(el.peerSelect.value)}`;
  }
  if (channelType === "shift_thread" && el.threadSelect.value) {
    path += `&threadId=${encodeURIComponent(el.threadSelect.value)}`;
  }

  const data = await api(path);
  renderList(
    el.messageFeed,
    data.messages,
    (message) => {
      const sender = state.users.find((user) => user.id === message.senderId);
      return `<div class="message"><div>${message.body}</div><div class="meta">${sender ? sender.name : message.senderId} � ${prettyDate(message.sentAt)}</div></div>`;
    },
    "No messages yet for this channel.",
  );
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

  loadPeerAndThreadOptions();
  updateMessageControls();
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
  el.heroBanner.classList.add("hidden");
  el.loginPanel.classList.add("hidden");
  el.appPanel.classList.remove("hidden");

  await refreshDashboard();
}

function logout() {
  setAuthToken("");
  state.user = null;
  el.appPanel.classList.add("hidden");
  el.heroBanner.classList.remove("hidden");
  el.loginPanel.classList.remove("hidden");
}

async function bootstrap() {
  try {
    const data = await api("/api/users", { headers: {}, body: undefined });
    state.users = data.users;
    renderUserCards();

    if (state.token) {
      el.heroBanner.classList.add("hidden");
      el.loginPanel.classList.add("hidden");
      el.appPanel.classList.remove("hidden");
      await refreshDashboard();
    }
  } catch (error) {
    showError(error.message);
  }
}

el.navMenu.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-section]");
  if (!btn) return;
  setActiveSection(btn.dataset.section);
});

el.userCards.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-login-email]");
  if (!btn) return;

  try {
    await login(btn.dataset.loginEmail, btn.dataset.loginPassword);
  } catch (error) {
    showError(error.message);
  }
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

el.channelType.addEventListener("change", async () => {
  try {
    updateMessageControls();
    await refreshMessages();
  } catch (error) {
    showError(error.message);
  }
});

el.peerSelect.addEventListener("change", async () => {
  try {
    await refreshMessages();
  } catch (error) {
    showError(error.message);
  }
});

el.threadSelect.addEventListener("change", async () => {
  try {
    await refreshMessages();
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
    const channelType = el.channelType.value;
    const payload = {
      channelType,
      body: el.messageInput.value,
    };

    if (channelType === "dm") {
      payload.recipientId = el.peerSelect.value;
    }
    if (channelType === "shift_thread") {
      payload.threadId = el.threadSelect.value;
    }

    await api("/api/messages", {
      method: "POST",
      body: payload,
    });

    el.messageInput.value = "";
    await refreshMessages();
  } catch (error) {
    showError(error.message);
  }
});

bootstrap();
