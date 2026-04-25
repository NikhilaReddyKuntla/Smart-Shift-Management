const crypto = require("node:crypto");

const ROLE = {
  MANAGER: "manager",
  STUDENT: "student",
};

const CHANNEL = {
  GROUP: "group",
  DM: "dm",
  SHIFT_THREAD: "shift_thread",
};

const ATTENDANCE_MARK = {
  PRESENT: "present",
  NO_SHOW: "no_show",
  EXCUSED: "excused",
};

const STAFFING_ACTION = {
  NUDGE_ASSIGNED: "nudge_assigned",
  NUDGE_CANDIDATES: "nudge_candidates",
};

const STAFFING_ACTION_COOLDOWN_MS = 2 * 60 * 60 * 1000;

class AppError extends Error {
  constructor(status, message, code = "APP_ERROR", details = undefined) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function id() {
  return crypto.randomUUID();
}

function toDate(value) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "Invalid date value", "INVALID_DATE", { value });
  }
  return parsed;
}

function iso(value) {
  return toDate(value).toISOString();
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new AppError(400, `Invalid ${label}`, "INVALID_ENUM", { value, allowed });
  }
}

function parseTimeToMinutes(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) {
    throw new AppError(400, "Invalid time format, expected HH:MM", "INVALID_TIME", { hhmm });
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (totalMinutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function getDurationHours(startAt, endAt) {
  return (toDate(endAt).getTime() - toDate(startAt).getTime()) / (1000 * 60 * 60);
}

function getWeekStartKey(dateValue) {
  const date = toDate(dateValue);
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function computeConfirmationDueAt(startAt, nowValue) {
  const start = toDate(startAt).getTime();
  const now = toDate(nowValue).getTime();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  return new Date(Math.max(start - twoHoursMs, now)).toISOString();
}

function getShiftUtcDayAndMinutes(shift) {
  const start = toDate(shift.startAt);
  const end = toDate(shift.endAt);
  if (start.getUTCDate() !== end.getUTCDate() || start.getUTCMonth() !== end.getUTCMonth() || start.getUTCFullYear() !== end.getUTCFullYear()) {
    throw new AppError(400, "Shifts spanning midnight are not supported in MVP", "SHIFT_CROSS_DAY");
  }
  const dayOfWeek = start.getUTCDay();
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
  return { dayOfWeek, startMinutes, endMinutes };
}

function getUserById(state, userId) {
  const user = state.users.find((u) => u.id === userId);
  if (!user) {
    throw new AppError(404, "User not found", "USER_NOT_FOUND", { userId });
  }
  return user;
}

function getShiftById(state, shiftId) {
  const shift = state.shifts.find((s) => s.id === shiftId);
  if (!shift) {
    throw new AppError(404, "Shift not found", "SHIFT_NOT_FOUND", { shiftId });
  }
  return shift;
}

function getSwapRequestById(state, swapRequestId) {
  const request = state.swapRequests.find((r) => r.id === swapRequestId);
  if (!request) {
    throw new AppError(404, "Swap request not found", "SWAP_REQUEST_NOT_FOUND", { swapRequestId });
  }
  return request;
}

function getDropRequestById(state, dropRequestId) {
  const request = state.dropRequests.find((r) => r.id === dropRequestId);
  if (!request) {
    throw new AppError(404, "Drop request not found", "DROP_REQUEST_NOT_FOUND", { dropRequestId });
  }
  return request;
}

function ensureRole(user, role) {
  if (user.role !== role) {
    throw new AppError(403, "Insufficient permissions", "FORBIDDEN", { requiredRole: role, actualRole: user.role });
  }
}

function validateShiftRange(startAt, endAt, nowValue) {
  const start = toDate(startAt);
  const end = toDate(endAt);
  const now = toDate(nowValue);
  if (end <= start) {
    throw new AppError(400, "Shift end must be after shift start", "INVALID_SHIFT_RANGE");
  }
  if (start <= now) {
    throw new AppError(400, "Shift start must be in the future", "SHIFT_IN_PAST");
  }
  getShiftUtcDayAndMinutes({ startAt: start, endAt: end });
}

function evaluateStudentForShift(state, studentId, shift, options = {}) {
  const ignoreShiftId = options.ignoreShiftId || null;
  const now = toDate(options.now || new Date());
  const reasons = [];
  const student = getUserById(state, studentId);
  if (student.role !== ROLE.STUDENT) {
    reasons.push("User is not a student");
    return { eligible: false, reasons };
  }

  if (!student.qualifications.includes(shift.roleNeeded)) {
    reasons.push("Missing required qualification");
  }

  const shiftStart = toDate(shift.startAt);
  const shiftEnd = toDate(shift.endAt);
  if (shiftStart <= now) {
    reasons.push("Shift has already started");
  }

  const conflictingAssignedShift = state.shifts.find((candidate) => {
    if (candidate.id === ignoreShiftId) return false;
    if (candidate.assignedUserId !== studentId) return false;
    if (candidate.status !== "assigned") return false;
    const candidateStart = toDate(candidate.startAt);
    const candidateEnd = toDate(candidate.endAt);
    return overlaps(shiftStart, shiftEnd, candidateStart, candidateEnd);
  });
  if (conflictingAssignedShift) {
    reasons.push("Conflicts with another assigned shift");
  }

  const weekKey = getWeekStartKey(shiftStart);
  const assignedWeekHours = state.shifts
    .filter((candidate) => {
      if (candidate.id === ignoreShiftId) return false;
      if (candidate.assignedUserId !== studentId) return false;
      if (candidate.status !== "assigned") return false;
      return getWeekStartKey(candidate.startAt) === weekKey;
    })
    .reduce((sum, candidate) => sum + getDurationHours(candidate.startAt, candidate.endAt), 0);
  const prospectiveHours = assignedWeekHours + getDurationHours(shift.startAt, shift.endAt);
  if (prospectiveHours > student.weeklyHourCap) {
    reasons.push("Weekly hour cap would be exceeded");
  }

  const { dayOfWeek, startMinutes, endMinutes } = getShiftUtcDayAndMinutes(shift);
  const conflictingAvailability = state.availabilitySlots.find((slot) => {
    if (slot.userId !== studentId) return false;
    if (!slot.busy) return false;
    if (slot.dayOfWeek !== dayOfWeek) return false;
    const slotStart = parseTimeToMinutes(slot.startTime);
    const slotEnd = parseTimeToMinutes(slot.endTime);
    return overlaps(startMinutes, endMinutes, slotStart, slotEnd);
  });
  if (conflictingAvailability) {
    reasons.push("Conflicts with class schedule availability");
  }

  return { eligible: reasons.length === 0, reasons };
}

function ensureShiftClaimable(state, studentId, shiftId, nowValue) {
  const shift = getShiftById(state, shiftId);
  if (shift.status !== "open") {
    throw new AppError(400, "Shift is not open for claiming", "SHIFT_NOT_OPEN");
  }
  const eligibility = evaluateStudentForShift(state, studentId, shift, { now: nowValue });
  if (!eligibility.eligible) {
    throw new AppError(400, "Student is not eligible to claim this shift", "INELIGIBLE_SHIFT", {
      reasons: eligibility.reasons,
    });
  }
  return shift;
}

function createShift(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  validateShiftRange(payload.startAt, payload.endAt, now);
  if (!payload.roleNeeded || !payload.location) {
    throw new AppError(400, "roleNeeded and location are required", "INVALID_SHIFT_INPUT");
  }

  const shift = {
    id: id(),
    startAt: iso(payload.startAt),
    endAt: iso(payload.endAt),
    roleNeeded: payload.roleNeeded,
    location: payload.location,
    status: "open",
    assignedUserId: null,
    claimedAt: null,
    confirmationDueAt: null,
    confirmedAt: null,
    reminderSentAt: null,
    createdBy: payload.managerId,
  };
  state.shifts.push(shift);
  return shift;
}

function claimShift(state, payload) {
  const now = toDate(payload.now || new Date());
  const student = getUserById(state, payload.studentId);
  ensureRole(student, ROLE.STUDENT);
  const shift = ensureShiftClaimable(state, payload.studentId, payload.shiftId, now);

  shift.status = "assigned";
  shift.assignedUserId = student.id;
  shift.claimedAt = now.toISOString();
  shift.confirmedAt = null;
  shift.confirmationDueAt = computeConfirmationDueAt(shift.startAt, now);
  shift.reminderSentAt = null;

  state.claims.push({
    id: id(),
    shiftId: shift.id,
    studentId: student.id,
    status: "completed",
    claimedAt: now.toISOString(),
  });

  sendNotification(state, {
    userId: student.id,
    subject: "Shift claimed",
    body: `You claimed the ${shift.roleNeeded} shift at ${shift.location}.`,
    kind: "claim",
    now,
    relatedShiftId: shift.id,
  });

  return shift;
}

function confirmShift(state, payload) {
  const now = toDate(payload.now || new Date());
  const student = getUserById(state, payload.studentId);
  ensureRole(student, ROLE.STUDENT);
  const shift = getShiftById(state, payload.shiftId);
  if (shift.assignedUserId !== student.id) {
    throw new AppError(403, "Cannot confirm a shift not assigned to you", "FORBIDDEN");
  }
  if (toDate(shift.startAt) <= now) {
    throw new AppError(400, "Cannot confirm a shift that already started", "SHIFT_ALREADY_STARTED");
  }

  shift.confirmedAt = now.toISOString();
  sendNotification(state, {
    userId: shift.createdBy,
    subject: "Shift confirmed",
    body: `${student.name} confirmed their upcoming shift.`,
    kind: "confirmation",
    now,
    relatedShiftId: shift.id,
  });
  return shift;
}
function createSwapRequest(state, payload) {
  const now = toDate(payload.now || new Date());
  const requester = getUserById(state, payload.requesterId);
  const candidate = getUserById(state, payload.candidateId);
  ensureRole(requester, ROLE.STUDENT);
  ensureRole(candidate, ROLE.STUDENT);
  if (requester.id === candidate.id) {
    throw new AppError(400, "Candidate cannot be requester", "INVALID_SWAP_REQUEST");
  }

  const shift = getShiftById(state, payload.shiftId);
  if (shift.assignedUserId !== requester.id) {
    throw new AppError(400, "Only assigned student can request a swap", "NOT_SHIFT_OWNER");
  }

  const candidateEligibility = evaluateStudentForShift(state, candidate.id, shift, {
    now,
    ignoreShiftId: shift.id,
  });
  if (!candidateEligibility.eligible) {
    throw new AppError(400, "Candidate is not eligible for this swap", "SWAP_CANDIDATE_INELIGIBLE", {
      reasons: candidateEligibility.reasons,
    });
  }

  const request = {
    id: id(),
    shiftId: shift.id,
    requesterId: requester.id,
    candidateId: candidate.id,
    status: "pending",
    history: [{ status: "pending", at: now.toISOString() }],
    managerDecisionAt: null,
    decision: null,
    createdAt: now.toISOString(),
  };
  state.swapRequests.push(request);

  sendNotification(state, {
    userId: shift.createdBy,
    subject: "Swap request pending",
    body: `${requester.name} requested a swap with ${candidate.name}.`,
    kind: "swap",
    now,
    relatedShiftId: shift.id,
  });

  return request;
}

function decideSwapRequest(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  assertEnum(payload.decision, ["approve", "reject"], "swap decision");

  const request = getSwapRequestById(state, payload.swapRequestId);
  if (request.status !== "pending") {
    throw new AppError(400, "Swap request is no longer pending", "INVALID_SWAP_STATUS");
  }

  const shift = getShiftById(state, request.shiftId);
  if (payload.decision === "reject") {
    request.status = "rejected";
    request.decision = "rejected";
    request.managerDecisionAt = now.toISOString();
    request.history.push({ status: "rejected", at: now.toISOString() });
    return request;
  }

  if (shift.assignedUserId !== request.requesterId) {
    throw new AppError(400, "Shift assignment changed before swap approval", "SWAP_STALE_REQUEST");
  }

  const candidateEligibility = evaluateStudentForShift(state, request.candidateId, shift, {
    now,
    ignoreShiftId: shift.id,
  });
  if (!candidateEligibility.eligible) {
    throw new AppError(400, "Candidate is no longer eligible", "SWAP_CANDIDATE_INELIGIBLE", {
      reasons: candidateEligibility.reasons,
    });
  }

  request.status = "approved";
  request.decision = "approved";
  request.managerDecisionAt = now.toISOString();
  request.history.push({ status: "approved", at: now.toISOString() });

  shift.assignedUserId = request.candidateId;
  shift.status = "assigned";
  shift.claimedAt = now.toISOString();
  shift.confirmedAt = null;
  shift.confirmationDueAt = computeConfirmationDueAt(shift.startAt, now);
  shift.reminderSentAt = null;

  request.status = "completed";
  request.history.push({ status: "completed", at: now.toISOString() });

  sendNotification(state, {
    userId: request.candidateId,
    subject: "Swap approved",
    body: "You are now assigned to a swapped shift.",
    kind: "swap",
    now,
    relatedShiftId: shift.id,
  });
  sendNotification(state, {
    userId: request.requesterId,
    subject: "Swap completed",
    body: "Your manager approved your swap request.",
    kind: "swap",
    now,
    relatedShiftId: shift.id,
  });

  return request;
}

function createDropRequest(state, payload) {
  const now = toDate(payload.now || new Date());
  const requester = getUserById(state, payload.requesterId);
  ensureRole(requester, ROLE.STUDENT);
  const shift = getShiftById(state, payload.shiftId);
  if (shift.assignedUserId !== requester.id) {
    throw new AppError(400, "Only assigned student can request a drop", "NOT_SHIFT_OWNER");
  }

  const request = {
    id: id(),
    shiftId: shift.id,
    requesterId: requester.id,
    status: "pending",
    history: [{ status: "pending", at: now.toISOString() }],
    managerDecisionAt: null,
    decision: null,
    createdAt: now.toISOString(),
  };
  state.dropRequests.push(request);

  sendNotification(state, {
    userId: shift.createdBy,
    subject: "Drop request pending",
    body: `${requester.name} requested to drop a shift.`,
    kind: "drop",
    now,
    relatedShiftId: shift.id,
  });

  return request;
}

function decideDropRequest(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  assertEnum(payload.decision, ["approve", "reject"], "drop decision");
  const request = getDropRequestById(state, payload.dropRequestId);
  if (request.status !== "pending") {
    throw new AppError(400, "Drop request is no longer pending", "INVALID_DROP_STATUS");
  }

  const shift = getShiftById(state, request.shiftId);
  if (payload.decision === "reject") {
    request.status = "rejected";
    request.decision = "rejected";
    request.managerDecisionAt = now.toISOString();
    request.history.push({ status: "rejected", at: now.toISOString() });
    return request;
  }

  if (shift.assignedUserId !== request.requesterId) {
    throw new AppError(400, "Shift assignment changed before drop approval", "DROP_STALE_REQUEST");
  }

  request.status = "approved";
  request.decision = "approved";
  request.managerDecisionAt = now.toISOString();
  request.history.push({ status: "approved", at: now.toISOString() });

  shift.status = "open";
  shift.assignedUserId = null;
  shift.claimedAt = null;
  shift.confirmationDueAt = null;
  shift.confirmedAt = null;
  shift.reminderSentAt = null;

  request.status = "completed";
  request.history.push({ status: "completed", at: now.toISOString() });

  sendNotification(state, {
    userId: request.requesterId,
    subject: "Drop approved",
    body: "Your shift drop request was approved and the shift was re-released.",
    kind: "drop",
    now,
    relatedShiftId: shift.id,
  });

  return request;
}

function upsertAttendance(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  assertEnum(payload.mark, Object.values(ATTENDANCE_MARK), "attendance mark");
  const shift = getShiftById(state, payload.shiftId);
  const studentId = payload.studentId || shift.assignedUserId;
  if (!studentId) {
    throw new AppError(400, "Shift has no assigned student", "SHIFT_UNASSIGNED");
  }

  let record = state.attendance.find((entry) => entry.shiftId === shift.id && entry.studentId === studentId);
  if (!record) {
    record = {
      id: id(),
      shiftId: shift.id,
      studentId,
      mark: payload.mark,
      markedBy: manager.id,
      markedAt: now.toISOString(),
    };
    state.attendance.push(record);
  } else {
    record.mark = payload.mark;
    record.markedBy = manager.id;
    record.markedAt = now.toISOString();
  }
  shift.status = "completed";
  return record;
}

function sendNotification(state, payload) {
  const now = toDate(payload.now || new Date());
  const user = getUserById(state, payload.userId);
  const inApp = {
    id: id(),
    userId: user.id,
    channel: "in_app",
    subject: payload.subject,
    body: payload.body,
    kind: payload.kind || "general",
    relatedShiftId: payload.relatedShiftId || null,
    createdAt: now.toISOString(),
    readAt: null,
  };
  state.notifications.push(inApp);

  state.emailLog.push({
    id: id(),
    userId: user.id,
    to: user.email,
    subject: payload.subject,
    body: payload.body,
    sentAt: now.toISOString(),
  });

  if (user.notificationPrefs.smsOptIn) {
    state.smsLog.push({
      id: id(),
      userId: user.id,
      to: user.phone,
      body: payload.body,
      sentAt: now.toISOString(),
    });
  }
}

function runReminderJob(state, payload = {}) {
  const now = toDate(payload.now || new Date());
  const windowHours = payload.windowHours || 24;
  const windowEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
  const reminderCooldownMs = 12 * 60 * 60 * 1000;
  let remindersSent = 0;

  for (const shift of state.shifts) {
    if (shift.status !== "assigned" || !shift.assignedUserId) continue;
    if (shift.confirmedAt) continue;
    const start = toDate(shift.startAt);
    if (start <= now || start > windowEnd) continue;
    if (shift.reminderSentAt) {
      const elapsed = now.getTime() - toDate(shift.reminderSentAt).getTime();
      if (elapsed < reminderCooldownMs) continue;
    }

    sendNotification(state, {
      userId: shift.assignedUserId,
      subject: "Upcoming shift reminder",
      body: `Please confirm your upcoming shift at ${shift.location}.`,
      kind: "reminder",
      now,
      relatedShiftId: shift.id,
    });
    shift.reminderSentAt = now.toISOString();
    remindersSent += 1;
  }

  return { remindersSent };
}

function getLastStaffingAction(state, shiftId, actionType) {
  return [...(state.staffingActions || [])]
    .filter((entry) => entry.shiftId === shiftId && entry.actionType === actionType)
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt))[0];
}

function ensureStaffingActionAllowed(state, shiftId, actionType, nowValue) {
  const now = toDate(nowValue || new Date());
  const last = getLastStaffingAction(state, shiftId, actionType);
  if (!last) return;
  const elapsedMs = now.getTime() - toDate(last.createdAt).getTime();
  if (elapsedMs < STAFFING_ACTION_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((STAFFING_ACTION_COOLDOWN_MS - elapsedMs) / (1000 * 60));
    throw new AppError(429, `Please wait ${minutesLeft} more minute(s) before repeating this action.`, "STAFFING_ACTION_COOLDOWN");
  }
}

function logStaffingAction(state, payload) {
  const now = toDate(payload.now || new Date());
  const entry = {
    id: id(),
    shiftId: payload.shiftId,
    actionType: payload.actionType,
    triggeredBy: payload.triggeredBy,
    targetUserIds: payload.targetUserIds,
    createdAt: now.toISOString(),
  };
  state.staffingActions = state.staffingActions || [];
  state.staffingActions.push(entry);
  return entry;
}

function runStaffingNudgeAssigned(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  const shift = getShiftById(state, payload.shiftId);
  if (shift.status !== "assigned" || !shift.assignedUserId) {
    throw new AppError(400, "Shift must be assigned to nudge the assigned student.", "INVALID_STAFFING_ACTION");
  }
  if (shift.confirmedAt) {
    throw new AppError(400, "Assigned student already confirmed this shift.", "ALREADY_CONFIRMED");
  }

  ensureStaffingActionAllowed(state, shift.id, STAFFING_ACTION.NUDGE_ASSIGNED, now);
  const student = getUserById(state, shift.assignedUserId);
  sendNotification(state, {
    userId: student.id,
    subject: "Manager follow-up: please confirm your shift",
    body: `Please confirm your ${shift.roleNeeded} shift at ${shift.location}.`,
    kind: "staffing_nudge",
    now,
    relatedShiftId: shift.id,
  });

  const actionEntry = logStaffingAction(state, {
    shiftId: shift.id,
    actionType: STAFFING_ACTION.NUDGE_ASSIGNED,
    triggeredBy: manager.id,
    targetUserIds: [student.id],
    now,
  });

  return {
    sentCount: 1,
    targets: [student.id],
    actionAt: actionEntry.createdAt,
  };
}

function runStaffingNudgeCandidates(state, payload) {
  const now = toDate(payload.now || new Date());
  const manager = getUserById(state, payload.managerId);
  ensureRole(manager, ROLE.MANAGER);
  const shift = getShiftById(state, payload.shiftId);
  if (shift.status !== "open") {
    throw new AppError(400, "Only open shifts can be nudged to candidate pool.", "INVALID_STAFFING_ACTION");
  }

  ensureStaffingActionAllowed(state, shift.id, STAFFING_ACTION.NUDGE_CANDIDATES, now);

  const eligibleCandidateIds = getEligibleCandidateIdsForShift(state, shift, now);
  const requestedIds = Array.isArray(payload.candidateIds) ? payload.candidateIds : [];
  const targetIds = (requestedIds.length ? requestedIds : eligibleCandidateIds.slice(0, 3)).filter((idValue) => eligibleCandidateIds.includes(idValue));

  if (!targetIds.length) {
    throw new AppError(400, "No eligible candidates are available to nudge.", "NO_ELIGIBLE_CANDIDATES");
  }

  for (const userId of targetIds) {
    sendNotification(state, {
      userId,
      subject: "Open shift needs coverage",
      body: `A manager flagged an open ${shift.roleNeeded} shift at ${shift.location}. If available, please claim it.`,
      kind: "staffing_nudge",
      now,
      relatedShiftId: shift.id,
    });
  }

  const actionEntry = logStaffingAction(state, {
    shiftId: shift.id,
    actionType: STAFFING_ACTION.NUDGE_CANDIDATES,
    triggeredBy: manager.id,
    targetUserIds: targetIds,
    now,
  });

  return {
    sentCount: targetIds.length,
    targets: targetIds,
    actionAt: actionEntry.createdAt,
  };
}

function normalizeAvailabilitySlots(slots) {
  if (!Array.isArray(slots)) {
    throw new AppError(400, "slots must be an array", "INVALID_AVAILABILITY");
  }
  return slots.map((slot) => {
    const dayOfWeek = Number(slot.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new AppError(400, "dayOfWeek must be integer 0-6", "INVALID_AVAILABILITY_SLOT", { slot });
    }
    const start = parseTimeToMinutes(slot.startTime);
    const end = parseTimeToMinutes(slot.endTime);
    if (end <= start) {
      throw new AppError(400, "Availability slot end must be after start", "INVALID_AVAILABILITY_SLOT", { slot });
    }
    if (start % 30 !== 0 || end % 30 !== 0) {
      throw new AppError(400, "Availability slots must align to 30-minute boundaries", "INVALID_AVAILABILITY_SLOT", {
        slot,
      });
    }
    return {
      id: slot.id || id(),
      userId: slot.userId,
      dayOfWeek,
      startTime: minutesToHHMM(start),
      endTime: minutesToHHMM(end),
      busy: slot.busy !== false,
    };
  });
}

function replaceStudentAvailability(state, payload) {
  const student = getUserById(state, payload.studentId);
  ensureRole(student, ROLE.STUDENT);
  const normalized = normalizeAvailabilitySlots(
    payload.slots.map((slot) => ({
      ...slot,
      userId: student.id,
      busy: true,
    })),
  );
  state.availabilitySlots = state.availabilitySlots.filter((slot) => slot.userId !== student.id);
  state.availabilitySlots.push(...normalized);
  return normalized;
}

function getStudentAvailability(state, studentId) {
  const student = getUserById(state, studentId);
  ensureRole(student, ROLE.STUDENT);
  return state.availabilitySlots.filter((slot) => slot.userId === student.id);
}

function normalizeDmThreadId(senderId, recipientId) {
  return [senderId, recipientId].sort().join("__");
}

function getShiftThreadParticipants(state, shiftId) {
  const participantIds = new Set();
  const shift = getShiftById(state, shiftId);
  if (shift.assignedUserId) {
    participantIds.add(shift.assignedUserId);
  }
  for (const request of state.swapRequests) {
    if (request.shiftId !== shiftId) continue;
    participantIds.add(request.requesterId);
    participantIds.add(request.candidateId);
  }
  for (const request of state.dropRequests) {
    if (request.shiftId !== shiftId) continue;
    participantIds.add(request.requesterId);
  }
  participantIds.add(shift.createdBy);
  return participantIds;
}

function canSendDm(sender, recipient) {
  if (sender.role === ROLE.STUDENT && recipient.role === ROLE.STUDENT) return true;
  if (sender.role === ROLE.STUDENT && recipient.role === ROLE.MANAGER) return true;
  if (sender.role === ROLE.MANAGER && recipient.role === ROLE.STUDENT) return true;
  return false;
}

function sendMessage(state, payload) {
  const now = toDate(payload.now || new Date());
  const sender = getUserById(state, payload.senderId);
  assertEnum(payload.channelType, Object.values(CHANNEL), "channelType");
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!body) {
    throw new AppError(400, "Message body is required", "INVALID_MESSAGE");
  }

  let threadId = payload.threadId || null;
  let recipientId = payload.recipientId || null;

  if (payload.channelType === CHANNEL.GROUP) {
    threadId = "department-main";
  } else if (payload.channelType === CHANNEL.DM) {
    if (!recipientId) {
      throw new AppError(400, "recipientId is required for direct messages", "INVALID_MESSAGE");
    }
    const recipient = getUserById(state, recipientId);
    if (!canSendDm(sender, recipient)) {
      throw new AppError(403, "Direct messaging permission denied", "FORBIDDEN_DM");
    }
    threadId = normalizeDmThreadId(sender.id, recipient.id);
  } else if (payload.channelType === CHANNEL.SHIFT_THREAD) {
    if (!threadId) {
      throw new AppError(400, "threadId (shiftId) is required for shift_thread messages", "INVALID_MESSAGE");
    }
    const participants = getShiftThreadParticipants(state, threadId);
    const isManager = sender.role === ROLE.MANAGER;
    if (!participants.has(sender.id) && !isManager) {
      throw new AppError(403, "User is not allowed to participate in this shift thread", "FORBIDDEN_SHIFT_THREAD");
    }
  }

  const message = {
    id: id(),
    channelType: payload.channelType,
    threadId,
    senderId: sender.id,
    recipientId,
    body,
    sentAt: now.toISOString(),
  };
  state.messages.push(message);
  return message;
}

function getMessagesForUser(state, payload) {
  const user = getUserById(state, payload.userId);
  const channelType = payload.channelType || null;
  const threadId = payload.threadId || null;
  const peerId = payload.peerId || null;
  let messages = state.messages;

  if (channelType) {
    assertEnum(channelType, Object.values(CHANNEL), "channelType");
    messages = messages.filter((message) => message.channelType === channelType);
  }

  if (channelType === CHANNEL.DM) {
    if (peerId) {
      const dmThreadId = normalizeDmThreadId(user.id, peerId);
      messages = messages.filter((message) => message.threadId === dmThreadId);
    } else {
      messages = messages.filter((message) => message.threadId.includes(user.id));
    }
  } else if (channelType === CHANNEL.SHIFT_THREAD) {
    if (threadId) {
      const participants = getShiftThreadParticipants(state, threadId);
      if (user.role !== ROLE.MANAGER && !participants.has(user.id)) {
        throw new AppError(403, "Forbidden shift thread", "FORBIDDEN_SHIFT_THREAD");
      }
      messages = messages.filter((message) => message.threadId === threadId);
    } else {
      messages = messages.filter((message) => {
        const participants = getShiftThreadParticipants(state, message.threadId);
        return user.role === ROLE.MANAGER || participants.has(user.id);
      });
    }
  } else if (channelType === CHANNEL.GROUP) {
    messages = messages.filter((message) => message.threadId === "department-main");
  }

  return messages.sort((a, b) => toDate(b.sentAt) - toDate(a.sentAt)).slice(0, 200);
}

function setSmsOptIn(state, payload) {
  const user = getUserById(state, payload.userId);
  user.notificationPrefs.smsOptIn = Boolean(payload.smsOptIn);
  return user.notificationPrefs;
}

function getNotificationsForUser(state, userId) {
  getUserById(state, userId);
  return state.notifications.filter((entry) => entry.userId === userId).sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
}

function getNoShowRiskShifts(state, nowValue) {
  const now = toDate(nowValue || new Date());
  const twelveHoursMs = 12 * 60 * 60 * 1000;
  return state.shifts.filter((shift) => {
    if (shift.status !== "assigned") return false;
    if (!shift.assignedUserId) return false;
    if (shift.confirmedAt) return false;
    const start = toDate(shift.startAt);
    if (start <= now) return false;
    const dueAt = shift.confirmationDueAt ? toDate(shift.confirmationDueAt) : new Date(start.getTime() - 2 * 60 * 60 * 1000);
    return now >= dueAt || start.getTime() - now.getTime() <= twelveHoursMs;
  });
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function getUpcomingShiftsForManager(state, nowValue) {
  const now = toDate(nowValue || new Date());
  return state.shifts.filter((shift) => toDate(shift.startAt) > now).sort((a, b) => toDate(a.startAt) - toDate(b.startAt));
}

function getStudentAttendanceSignal(state, studentId) {
  const relevant = state.attendance.filter((entry) => entry.studentId === studentId && [ATTENDANCE_MARK.PRESENT, ATTENDANCE_MARK.NO_SHOW].includes(entry.mark));
  if (!relevant.length) {
    return { sampleSize: 0, noShowRate: null };
  }
  const noShowCount = relevant.filter((entry) => entry.mark === ATTENDANCE_MARK.NO_SHOW).length;
  return {
    sampleSize: relevant.length,
    noShowRate: Number((noShowCount / relevant.length).toFixed(3)),
  };
}

function getEligibleCandidateIdsForShift(state, shift, nowValue) {
  const now = toDate(nowValue || new Date());
  const students = state.users.filter((user) => user.role === ROLE.STUDENT);
  const options = shift.assignedUserId ? { now, ignoreShiftId: shift.id } : { now };
  return students
    .filter((student) => student.id !== shift.assignedUserId)
    .filter((student) => evaluateStudentForShift(state, student.id, shift, options).eligible)
    .map((student) => student.id);
}

function getRiskLevel(score) {
  if (score >= 75) return "critical";
  if (score >= 55) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function getShiftFillRiskItem(state, shift, nowValue) {
  const now = toDate(nowValue || new Date());
  const start = toDate(shift.startAt);
  const hoursToStart = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
  const eligibleCandidateIds = getEligibleCandidateIdsForShift(state, shift, now);
  const reasons = [];
  const recommendedActions = [];
  let score = 0;

  if (shift.status === "open" || !shift.assignedUserId) {
    score += 45;
    reasons.push("Shift is currently unfilled.");
  }

  if (hoursToStart <= 12) {
    score += 28;
    reasons.push("Shift starts within 12 hours.");
  } else if (hoursToStart <= 24) {
    score += 20;
    reasons.push("Shift starts within 24 hours.");
  } else if (hoursToStart <= 48) {
    score += 12;
  } else if (hoursToStart <= 72) {
    score += 7;
  }

  if (eligibleCandidateIds.length === 0) {
    score += 24;
    reasons.push("No eligible candidates are available right now.");
  } else if (eligibleCandidateIds.length === 1) {
    score += 16;
    reasons.push("Only one eligible backup candidate is available.");
  } else if (eligibleCandidateIds.length <= 3) {
    score += 9;
    reasons.push("Eligible candidate pool is small.");
  }

  if (shift.status === "assigned" && shift.assignedUserId) {
    const signal = getStudentAttendanceSignal(state, shift.assignedUserId);
    if (!shift.confirmedAt) {
      score += 18;
      reasons.push("Assigned student has not confirmed yet.");
      const dueAt = shift.confirmationDueAt ? toDate(shift.confirmationDueAt) : new Date(start.getTime() - 2 * 60 * 60 * 1000);
      if (now >= dueAt) {
        score += 20;
        reasons.push("Confirmation deadline has passed.");
      } else if (dueAt.getTime() - now.getTime() <= 2 * 60 * 60 * 1000) {
        score += 9;
        reasons.push("Confirmation deadline is approaching.");
      }
      recommendedActions.push({
        type: STAFFING_ACTION.NUDGE_ASSIGNED,
        label: "Nudge assigned student",
      });
    } else {
      score -= 8;
    }

    if (signal.sampleSize > 0 && signal.noShowRate !== null) {
      if (signal.noShowRate >= 0.5) {
        score += 12;
        reasons.push("Assigned student has elevated historical no-show rate.");
      } else if (signal.noShowRate >= 0.25) {
        score += 6;
      } else if (signal.noShowRate === 0) {
        score -= 4;
      }
    }
  }

  if (shift.status === "open") {
    if (eligibleCandidateIds.length > 0) {
      recommendedActions.push({
        type: STAFFING_ACTION.NUDGE_CANDIDATES,
        label: "Nudge top eligible candidates",
        candidateIds: eligibleCandidateIds.slice(0, 3),
      });
    }
  }

  const fillRiskScore = clamp(Math.round(score), 0, 100);

  return {
    shiftId: shift.id,
    fillRiskScore,
    riskLevel: getRiskLevel(fillRiskScore),
    reasons: reasons.slice(0, 4),
    recommendedActions,
    eligibleCandidateIds,
    status: shift.status,
    startAt: shift.startAt,
    endAt: shift.endAt,
    roleNeeded: shift.roleNeeded,
    location: shift.location,
    assignedUserId: shift.assignedUserId || null,
  };
}

function getStaffingCopilotDashboard(state, nowValue) {
  const now = toDate(nowValue || new Date());
  const horizonEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const candidateShifts = state.shifts.filter((shift) => {
    if (!["open", "assigned"].includes(shift.status)) return false;
    const start = toDate(shift.startAt);
    return start > now && start <= horizonEnd;
  });

  const items = candidateShifts
    .map((shift) => getShiftFillRiskItem(state, shift, now))
    .sort((a, b) => {
      if (b.fillRiskScore !== a.fillRiskScore) return b.fillRiskScore - a.fillRiskScore;
      return toDate(a.startAt) - toDate(b.startAt);
    });

  return {
    summary: {
      criticalCount: items.filter((item) => item.riskLevel === "critical").length,
      highCount: items.filter((item) => item.riskLevel === "high").length,
      unfilledCount: items.filter((item) => item.status === "open").length,
    },
    items,
  };
}

function getManagerDashboard(state, managerId, nowValue) {
  const manager = getUserById(state, managerId);
  ensureRole(manager, ROLE.MANAGER);
  const now = toDate(nowValue || new Date());
  const openShifts = state.shifts.filter((shift) => shift.status === "open");
  const confirmationsPending = state.shifts.filter((shift) => {
    if (shift.status !== "assigned") return false;
    if (!shift.assignedUserId) return false;
    if (shift.confirmedAt) return false;
    return toDate(shift.startAt) > now;
  });
  const noShowRisk = getNoShowRiskShifts(state, now);
  const pendingSwapRequests = state.swapRequests.filter((request) => request.status === "pending");
  const pendingDropRequests = state.dropRequests.filter((request) => request.status === "pending");

  const attendance = state.attendance;
  const presentCount = attendance.filter((entry) => entry.mark === ATTENDANCE_MARK.PRESENT).length;
  const noShowCount = attendance.filter((entry) => entry.mark === ATTENDANCE_MARK.NO_SHOW).length;
  const noShowRate = presentCount + noShowCount === 0 ? 0 : Number((noShowCount / (presentCount + noShowCount)).toFixed(3));
  const staffingCopilot = getStaffingCopilotDashboard(state, now);
  const upcomingShifts = getUpcomingShiftsForManager(state, now);

  return {
    metrics: {
      openShiftCount: openShifts.length,
      confirmationsPendingCount: confirmationsPending.length,
      noShowRiskCount: noShowRisk.length,
      noShowCount,
      noShowRate,
    },
    openShifts,
    confirmationsPending,
    noShowRisk,
    pendingSwapRequests,
    pendingDropRequests,
    staffingCopilot,
    upcomingShifts,
  };
}

function getStudentDashboard(state, studentId, nowValue) {
  const student = getUserById(state, studentId);
  ensureRole(student, ROLE.STUDENT);
  const now = toDate(nowValue || new Date());
  const upcomingShifts = state.shifts
    .filter((shift) => shift.assignedUserId === student.id && toDate(shift.startAt) > now)
    .sort((a, b) => toDate(a.startAt) - toDate(b.startAt));
  const confirmationTasks = upcomingShifts.filter((shift) => !shift.confirmedAt);

  const claimableShifts = state.shifts
    .filter((shift) => shift.status === "open")
    .filter((shift) => evaluateStudentForShift(state, student.id, shift, { now }).eligible);

  const requestHistory = {
    swapRequests: state.swapRequests.filter((request) => request.requesterId === student.id || request.candidateId === student.id),
    dropRequests: state.dropRequests.filter((request) => request.requesterId === student.id),
  };

  return {
    upcomingShifts,
    confirmationTasks,
    claimableShifts,
    requestHistory,
    notifications: getNotificationsForUser(state, student.id).slice(0, 20),
  };
}

function listUsersForUi(state) {
  return state.users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    qualifications: user.qualifications,
    weeklyHourCap: user.weeklyHourCap,
    notificationPrefs: user.notificationPrefs,
  }));
}

function createSeedState(nowValue = new Date()) {
  const now = toDate(nowValue);
  const plusHours = (hours) => new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const minusHours = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  const plusDays = (days, hour, minute) => {
    const target = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    target.setUTCHours(hour, minute, 0, 0);
    return target.toISOString();
  };

  const manager = {
    id: "u_manager_1",
    name: "Alex Manager",
    role: ROLE.MANAGER,
    email: "manager@bu.edu",
    password: "manager123",
    phone: "+16175550001",
    qualifications: [],
    weeklyHourCap: 0,
    notificationPrefs: { inApp: true, email: true, smsOptIn: false },
  };
  const studentA = {
    id: "u_student_1",
    name: "Maya Patel",
    role: ROLE.STUDENT,
    email: "maya@bu.edu",
    password: "student123",
    phone: "+16175550011",
    qualifications: ["front_desk", "library"],
    weeklyHourCap: 15,
    notificationPrefs: { inApp: true, email: true, smsOptIn: false },
  };
  const studentB = {
    id: "u_student_2",
    name: "Jordan Lee",
    role: ROLE.STUDENT,
    email: "jordan@bu.edu",
    password: "student123",
    phone: "+16175550012",
    qualifications: ["library"],
    weeklyHourCap: 12,
    notificationPrefs: { inApp: true, email: true, smsOptIn: true },
  };
  const studentC = {
    id: "u_student_3",
    name: "Sam Rivera",
    role: ROLE.STUDENT,
    email: "sam@bu.edu",
    password: "student123",
    phone: "+16175550013",
    qualifications: ["front_desk"],
    weeklyHourCap: 10,
    notificationPrefs: { inApp: true, email: true, smsOptIn: false },
  };

  const shifts = [
    {
      id: "shift_open_1",
      startAt: plusDays(1, 16, 0),
      endAt: plusDays(1, 18, 0),
      roleNeeded: "front_desk",
      location: "George Sherman Union",
      status: "open",
      assignedUserId: null,
      claimedAt: null,
      confirmationDueAt: null,
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_open_2",
      startAt: plusDays(2, 14, 0),
      endAt: plusDays(2, 16, 0),
      roleNeeded: "library",
      location: "Mugar Memorial Library",
      status: "open",
      assignedUserId: null,
      claimedAt: null,
      confirmationDueAt: null,
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_open_3",
      startAt: plusDays(3, 9, 0),
      endAt: plusDays(3, 12, 0),
      roleNeeded: "front_desk",
      location: "FitRec Front Desk",
      status: "open",
      assignedUserId: null,
      claimedAt: null,
      confirmationDueAt: null,
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_open_4",
      startAt: plusDays(5, 11, 0),
      endAt: plusDays(5, 14, 0),
      roleNeeded: "library",
      location: "Pardee Library",
      status: "open",
      assignedUserId: null,
      claimedAt: null,
      confirmationDueAt: null,
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_assigned_pending",
      startAt: plusHours(3),
      endAt: plusHours(5),
      roleNeeded: "library",
      location: "Mugar Memorial Library",
      status: "assigned",
      assignedUserId: studentA.id,
      claimedAt: now.toISOString(),
      confirmationDueAt: computeConfirmationDueAt(plusHours(3), now),
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_assigned_pending_2",
      startAt: plusDays(1, 10, 0),
      endAt: plusDays(1, 12, 0),
      roleNeeded: "library",
      location: "Mugar Memorial Library",
      status: "assigned",
      assignedUserId: studentB.id,
      claimedAt: minusHours(8),
      confirmationDueAt: computeConfirmationDueAt(plusDays(1, 10, 0), now),
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_assigned_pending_3",
      startAt: plusDays(2, 17, 0),
      endAt: plusDays(2, 19, 0),
      roleNeeded: "front_desk",
      location: "George Sherman Union",
      status: "assigned",
      assignedUserId: studentC.id,
      claimedAt: minusHours(6),
      confirmationDueAt: computeConfirmationDueAt(plusDays(2, 17, 0), now),
      confirmedAt: null,
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_assigned_confirmed_1",
      startAt: plusDays(4, 13, 0),
      endAt: plusDays(4, 15, 0),
      roleNeeded: "library",
      location: "Mugar Memorial Library",
      status: "assigned",
      assignedUserId: studentA.id,
      claimedAt: minusHours(24),
      confirmationDueAt: computeConfirmationDueAt(plusDays(4, 13, 0), now),
      confirmedAt: minusHours(2),
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_assigned_confirmed_2",
      startAt: plusDays(6, 9, 30),
      endAt: plusDays(6, 11, 30),
      roleNeeded: "front_desk",
      location: "Questrom Help Desk",
      status: "assigned",
      assignedUserId: studentC.id,
      claimedAt: minusHours(20),
      confirmationDueAt: computeConfirmationDueAt(plusDays(6, 9, 30), now),
      confirmedAt: minusHours(3),
      reminderSentAt: null,
      createdBy: manager.id,
    },
    {
      id: "shift_completed_1",
      startAt: plusDays(-1, 14, 0),
      endAt: plusDays(-1, 16, 0),
      roleNeeded: "library",
      location: "Mugar Memorial Library",
      status: "completed",
      assignedUserId: studentB.id,
      claimedAt: plusDays(-2, 12, 0),
      confirmationDueAt: computeConfirmationDueAt(plusDays(-1, 14, 0), now),
      confirmedAt: plusDays(-1, 10, 0),
      reminderSentAt: plusDays(-1, 8, 0),
      createdBy: manager.id,
    },
  ];

  const classConflictDay = toDate(plusDays(1, 0, 0)).getUTCDay();
  const availabilitySlots = [
    { id: id(), userId: studentA.id, dayOfWeek: classConflictDay, startTime: "09:00", endTime: "11:00", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 1, startTime: "13:00", endTime: "14:30", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 1, startTime: "16:00", endTime: "17:00", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 2, startTime: "10:00", endTime: "11:30", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 2, startTime: "15:30", endTime: "17:00", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 3, startTime: "12:30", endTime: "14:00", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 4, startTime: "09:30", endTime: "11:00", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 4, startTime: "16:00", endTime: "17:30", busy: true },
    { id: id(), userId: studentA.id, dayOfWeek: 5, startTime: "11:00", endTime: "12:30", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 1, startTime: "09:30", endTime: "11:00", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 1, startTime: "13:00", endTime: "15:00", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 2, startTime: "11:00", endTime: "12:30", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 2, startTime: "14:30", endTime: "16:00", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 3, startTime: "10:00", endTime: "11:30", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 3, startTime: "13:00", endTime: "14:30", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 4, startTime: "16:30", endTime: "18:00", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 5, startTime: "09:00", endTime: "10:30", busy: true },
    { id: id(), userId: studentB.id, dayOfWeek: 5, startTime: "12:00", endTime: "13:30", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 1, startTime: "10:00", endTime: "11:30", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 1, startTime: "14:00", endTime: "15:30", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 2, startTime: "09:00", endTime: "10:30", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 3, startTime: "11:30", endTime: "13:00", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 3, startTime: "15:00", endTime: "16:30", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 4, startTime: "10:30", endTime: "12:00", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 4, startTime: "13:30", endTime: "15:00", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 5, startTime: "09:30", endTime: "11:00", busy: true },
    { id: id(), userId: studentC.id, dayOfWeek: 5, startTime: "12:30", endTime: "14:00", busy: true },
  ];

  const attendance = [
    {
      id: id(),
      shiftId: "shift_completed_1",
      studentId: studentB.id,
      mark: ATTENDANCE_MARK.EXCUSED,
      markedBy: manager.id,
      markedAt: minusHours(12),
    },
  ];

  return {
    users: [manager, studentA, studentB, studentC],
    availabilitySlots,
    shifts,
    claims: [],
    swapRequests: [],
    dropRequests: [],
    attendance,
    messages: [
      {
        id: id(),
        channelType: CHANNEL.GROUP,
        threadId: "department-main",
        senderId: manager.id,
        recipientId: null,
        body: "Welcome to the BU Shift Manager pilot. Please confirm shifts on time.",
        sentAt: now.toISOString(),
      },
    ],
    notifications: [],
    emailLog: [],
    smsLog: [],
    staffingActions: [],
  };
}

module.exports = {
  AppError,
  ATTENDANCE_MARK,
  CHANNEL,
  ROLE,
  STAFFING_ACTION,
  canSendDm,
  claimShift,
  computeConfirmationDueAt,
  createDropRequest,
  createSeedState,
  createShift,
  createSwapRequest,
  decideDropRequest,
  decideSwapRequest,
  evaluateStudentForShift,
  getManagerDashboard,
  getMessagesForUser,
  getNotificationsForUser,
  getStudentAvailability,
  getStudentDashboard,
  getUserById,
  getShiftById,
  listUsersForUi,
  replaceStudentAvailability,
  runReminderJob,
  runStaffingNudgeAssigned,
  runStaffingNudgeCandidates,
  sendMessage,
  sendNotification,
  setSmsOptIn,
  upsertAttendance,
  confirmShift,
};
