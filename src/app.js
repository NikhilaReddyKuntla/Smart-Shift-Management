const path = require("node:path");
const express = require("express");

const {
  AppError,
  ATTENDANCE_MARK,
  CHANNEL,
  ROLE,
  claimShift,
  createDropRequest,
  createShift,
  createSwapRequest,
  decideDropRequest,
  decideSwapRequest,
  evaluateStudentForShift,
  getManagerDashboard,
  getMessagesForUser,
  getNotificationsForUser,
  getShiftById,
  getStudentAvailability,
  getStudentDashboard,
  getUserById,
  listUsersForUi,
  replaceStudentAvailability,
  runReminderJob,
  runStaffingNudgeAssigned,
  runStaffingNudgeCandidates,
  sendMessage,
  updateNotificationPrefs,
  upsertAttendance,
  confirmShift,
} = require("./domain");
const { createStore } = require("./store");

const defaultStore = createStore();

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    qualifications: user.qualifications,
    weeklyHourCap: user.weeklyHourCap,
    notificationPrefs: user.notificationPrefs,
  };
}

function buildPublicUserList(state) {
  return state.users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    qualifications: user.qualifications,
  }));
}

function createApp(store = defaultStore) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  function getState() {
    return store.getState();
  }

  function requireUser(req, _res, next) {
    const userId = req.get("x-user-id") || req.query.userId;
    if (!userId) {
      return next(new AppError(401, "Missing x-user-id header", "UNAUTHORIZED"));
    }
    const state = getState();
    const user = state.users.find((entry) => entry.id === userId);
    if (!user) {
      return next(new AppError(401, "Invalid user", "UNAUTHORIZED"));
    }
    req.user = user;
    return next();
  }

  function requireRole(role) {
    return (req, _res, next) => {
      if (!req.user) {
        return next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
      }
      if (req.user.role !== role) {
        return next(new AppError(403, "Forbidden", "FORBIDDEN"));
      }
      return next();
    };
  }

  function asIsoOrNull(value) {
    if (!value) return null;
    return new Date(value).toISOString();
  }

  function enrichShift(state, shift) {
    const assignedUser = shift.assignedUserId ? state.users.find((user) => user.id === shift.assignedUserId) : null;
    const manager = state.users.find((user) => user.id === shift.createdBy);
    const eligibility =
      state.currentViewerRole === ROLE.STUDENT && state.currentViewerId
        ? evaluateStudentForShift(state, state.currentViewerId, shift, { now: new Date() })
        : null;

    return {
      ...shift,
      assignedUserName: assignedUser ? assignedUser.name : null,
      managerName: manager ? manager.name : null,
      studentEligibility: eligibility,
    };
  }

  function enrichSwapRequest(state, request) {
    const requester = state.users.find((user) => user.id === request.requesterId);
    const candidate = state.users.find((user) => user.id === request.candidateId);
    const shift = state.shifts.find((entry) => entry.id === request.shiftId);
    return {
      ...request,
      requesterName: requester ? requester.name : request.requesterId,
      candidateName: candidate ? candidate.name : request.candidateId,
      shift: shift ? enrichShift(state, shift) : null,
    };
  }

  function enrichDropRequest(state, request) {
    const requester = state.users.find((user) => user.id === request.requesterId);
    const shift = state.shifts.find((entry) => entry.id === request.shiftId);
    return {
      ...request,
      requesterName: requester ? requester.name : request.requesterId,
      shift: shift ? enrichShift(state, shift) : null,
    };
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "bu-shift-manager" });
  });

  app.get("/api/users", (_req, res) => {
    const state = getState();
    res.json({ users: buildPublicUserList(state) });
  });

  app.post("/api/auth/login", (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        throw new AppError(400, "email and password are required", "INVALID_LOGIN");
      }
      const state = getState();
      const user = state.users.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase() && entry.password === password);
      if (!user) {
        throw new AppError(401, "Invalid credentials", "INVALID_LOGIN");
      }
      res.json({ token: user.id, user: safeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me", requireUser, (req, res) => {
    res.json({ user: safeUser(req.user) });
  });

  app.patch("/api/me/notification-prefs", requireUser, (req, res, next) => {
    try {
      const { smsOptIn, slackOptIn } = req.body || {};
      const prefs = updateNotificationPrefs(getState(), { userId: req.user.id, smsOptIn, slackOptIn });
      res.json({ notificationPrefs: prefs });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/shifts", requireUser, (req, res, next) => {
    try {
      const state = getState();
      state.currentViewerRole = req.user.role;
      state.currentViewerId = req.user.id;

      const statusFilter = req.query.status ? String(req.query.status) : null;
      let shifts = state.shifts;
      if (req.user.role === ROLE.STUDENT) {
        shifts = shifts.filter((shift) => shift.status === "open" || shift.assignedUserId === req.user.id);
      }
      if (statusFilter) {
        shifts = shifts.filter((shift) => shift.status === statusFilter);
      }

      res.json({ shifts: shifts.map((shift) => enrichShift(state, shift)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/shifts", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { startAt, endAt, roleNeeded, location } = req.body || {};
      const shift = createShift(getState(), {
        managerId: req.user.id,
        startAt,
        endAt,
        roleNeeded,
        location,
        now: new Date(),
      });
      res.status(201).json({ shift });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/shifts/:id/claim", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const shift = claimShift(getState(), {
        studentId: req.user.id,
        shiftId: req.params.id,
        now: new Date(),
      });
      res.status(201).json({ shift });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/shifts/:id/confirm", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const shift = confirmShift(getState(), {
        studentId: req.user.id,
        shiftId: req.params.id,
        now: new Date(),
      });
      res.json({ shift });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/swaps", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const { shiftId, candidateId } = req.body || {};
      const request = createSwapRequest(getState(), {
        requesterId: req.user.id,
        shiftId,
        candidateId,
        now: new Date(),
      });
      res.status(201).json({ request });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/swaps/:id/decision", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { decision } = req.body || {};
      const request = decideSwapRequest(getState(), {
        managerId: req.user.id,
        swapRequestId: req.params.id,
        decision,
        now: new Date(),
      });
      res.json({ request });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drops", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const { shiftId } = req.body || {};
      const request = createDropRequest(getState(), {
        requesterId: req.user.id,
        shiftId,
        now: new Date(),
      });
      res.status(201).json({ request });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drops/:id/decision", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { decision } = req.body || {};
      const request = decideDropRequest(getState(), {
        managerId: req.user.id,
        dropRequestId: req.params.id,
        decision,
        now: new Date(),
      });
      res.json({ request });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/attendance", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { shiftId, studentId, mark } = req.body || {};
      if (!Object.values(ATTENDANCE_MARK).includes(mark)) {
        throw new AppError(400, "Invalid attendance mark", "INVALID_ATTENDANCE");
      }
      const attendance = upsertAttendance(getState(), {
        managerId: req.user.id,
        shiftId,
        studentId,
        mark,
        now: new Date(),
      });
      res.json({ attendance });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard/manager", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const state = getState();
      const dashboard = getManagerDashboard(state, req.user.id, new Date());
      res.json({
        ...dashboard,
        openShifts: dashboard.openShifts.map((shift) => enrichShift(state, shift)),
        confirmationsPending: dashboard.confirmationsPending.map((shift) => enrichShift(state, shift)),
        noShowRisk: dashboard.noShowRisk.map((shift) => enrichShift(state, shift)),
        pendingSwapRequests: dashboard.pendingSwapRequests.map((request) => enrichSwapRequest(state, request)),
        pendingDropRequests: dashboard.pendingDropRequests.map((request) => enrichDropRequest(state, request)),
        upcomingShifts: dashboard.upcomingShifts.map((shift) => enrichShift(state, shift)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard/student", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const state = getState();
      const dashboard = getStudentDashboard(state, req.user.id, new Date());
      res.json({
        ...dashboard,
        confirmationTasks: dashboard.confirmationTasks.map((shift) => enrichShift(state, shift)),
        claimableShifts: dashboard.claimableShifts.map((shift) => enrichShift(state, shift)),
        upcomingShifts: dashboard.upcomingShifts.map((shift) => enrichShift(state, shift)),
        requestHistory: {
          swapRequests: dashboard.requestHistory.swapRequests.map((request) => enrichSwapRequest(state, request)),
          dropRequests: dashboard.requestHistory.dropRequests.map((request) => enrichDropRequest(state, request)),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/availability", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const slots = getStudentAvailability(getState(), req.user.id);
      res.json({ slots });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/availability", requireUser, requireRole(ROLE.STUDENT), (req, res, next) => {
    try {
      const { slots } = req.body || {};
      const updated = replaceStudentAvailability(getState(), {
        studentId: req.user.id,
        slots,
      });
      res.json({ slots: updated });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/requests/history", requireUser, requireRole(ROLE.STUDENT), (req, res) => {
    const state = getState();
    const swapRequests = state.swapRequests.filter((request) => request.requesterId === req.user.id || request.candidateId === req.user.id);
    const dropRequests = state.dropRequests.filter((request) => request.requesterId === req.user.id);
    res.json({
      swapRequests: swapRequests.map((request) => enrichSwapRequest(state, request)),
      dropRequests: dropRequests.map((request) => enrichDropRequest(state, request)),
    });
  });

  app.get("/api/requests/pending", requireUser, requireRole(ROLE.MANAGER), (req, res) => {
    const state = getState();
    const pendingSwapRequests = state.swapRequests.filter((request) => request.status === "pending");
    const pendingDropRequests = state.dropRequests.filter((request) => request.status === "pending");
    res.json({
      pendingSwapRequests: pendingSwapRequests.map((request) => enrichSwapRequest(state, request)),
      pendingDropRequests: pendingDropRequests.map((request) => enrichDropRequest(state, request)),
    });
  });

  app.get("/api/messages", requireUser, (req, res, next) => {
    try {
      const messages = getMessagesForUser(getState(), {
        userId: req.user.id,
        channelType: req.query.channelType,
        threadId: req.query.threadId,
        peerId: req.query.peerId,
      });
      res.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/messages", requireUser, (req, res, next) => {
    try {
      const { channelType, threadId, recipientId, body } = req.body || {};
      const message = sendMessage(getState(), {
        senderId: req.user.id,
        channelType,
        threadId,
        recipientId,
        body,
        now: new Date(),
      });
      res.status(201).json({ message });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/notifications", requireUser, (req, res, next) => {
    try {
      const notifications = getNotificationsForUser(getState(), req.user.id);
      res.json({ notifications });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/reminders/run", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const result = runReminderJob(getState(), {
        now: new Date(),
        windowHours: Number(req.body?.windowHours || 24),
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/staffing/actions/nudge-assigned", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { shiftId } = req.body || {};
      const result = runStaffingNudgeAssigned(getState(), {
        managerId: req.user.id,
        shiftId,
        now: new Date(),
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/staffing/actions/nudge-candidates", requireUser, requireRole(ROLE.MANAGER), (req, res, next) => {
    try {
      const { shiftId, candidateIds } = req.body || {};
      const result = runStaffingNudgeCandidates(getState(), {
        managerId: req.user.id,
        shiftId,
        candidateIds,
        now: new Date(),
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/debug/state", requireUser, requireRole(ROLE.MANAGER), (_req, res) => {
    const state = getState();
    res.json({
      users: listUsersForUi(state),
      shifts: state.shifts,
      swapRequests: state.swapRequests,
      dropRequests: state.dropRequests,
      attendance: state.attendance,
      staffingActions: state.staffingActions,
      notifications: state.notifications,
      emailLog: state.emailLog,
      smsLog: state.smsLog,
      slackLog: state.slackLog,
    });
  });

  app.post("/api/dev/reset", (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    store.reset(new Date());
    return res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next(new AppError(404, "API route not found", "NOT_FOUND"));
    }
    return res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const payload = {
      error: {
        code,
        message: error.message || "Unexpected error",
      },
    };
    if (error instanceof AppError && error.details) {
      payload.error.details = error.details;
    }
    if (!(error instanceof AppError) && process.env.NODE_ENV !== "production") {
      payload.error.stack = error.stack;
    }
    res.status(status).json(payload);
  });

  return app;
}

module.exports = {
  createApp,
  defaultStore,
  ROLE,
  CHANNEL,
};
