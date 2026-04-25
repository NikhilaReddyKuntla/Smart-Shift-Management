const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AppError,
  claimShift,
  createDropRequest,
  createSeedState,
  createSwapRequest,
  decideDropRequest,
  decideSwapRequest,
  getManagerDashboard,
  getStudentAvailability,
  runReminderJob,
  runStaffingNudgeAssigned,
  runStaffingNudgeCandidates,
  sendMessage,
  setSmsOptIn,
  upsertAttendance,
} = require("../src/domain");

const baseNow = new Date("2026-04-14T12:00:00.000Z");

function makeOpenShift(id, startAt, endAt, roleNeeded = "front_desk", location = "GSU") {
  return {
    id,
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(endAt).toISOString(),
    roleNeeded,
    location,
    status: "open",
    assignedUserId: null,
    claimedAt: null,
    confirmationDueAt: null,
    confirmedAt: null,
    reminderSentAt: null,
    createdBy: "u_manager_1",
  };
}

test("student cannot claim when missing qualification", () => {
  const state = createSeedState(baseNow);
  assert.throws(
    () => {
      claimShift(state, {
        studentId: "u_student_2",
        shiftId: "shift_open_1",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error instanceof AppError, true);
      assert.equal(error.code, "INELIGIBLE_SHIFT");
      assert.match(error.details.reasons.join("|"), /Missing required qualification/);
      return true;
    },
  );
});

test("student cannot claim when class schedule conflicts", () => {
  const state = createSeedState(baseNow);
  const nextDay = new Date(baseNow.getTime() + 24 * 60 * 60 * 1000);
  nextDay.setUTCHours(9, 30, 0, 0);
  const end = new Date(nextDay.getTime() + 60 * 60 * 1000);
  state.shifts.push(makeOpenShift("shift_class_conflict", nextDay, end));

  assert.throws(
    () => {
      claimShift(state, {
        studentId: "u_student_1",
        shiftId: "shift_class_conflict",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error.code, "INELIGIBLE_SHIFT");
      assert.match(error.details.reasons.join("|"), /class schedule availability/);
      return true;
    },
  );
});

test("student cannot claim when shift overlaps assigned shift", () => {
  const state = createSeedState(baseNow);
  const start = new Date(baseNow.getTime() + 4 * 60 * 60 * 1000);
  const end = new Date(baseNow.getTime() + 6 * 60 * 60 * 1000);
  state.shifts.push(makeOpenShift("shift_overlap", start, end, "library", "Mugar"));

  assert.throws(
    () => {
      claimShift(state, {
        studentId: "u_student_1",
        shiftId: "shift_overlap",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error.code, "INELIGIBLE_SHIFT");
      assert.match(error.details.reasons.join("|"), /Conflicts with another assigned shift/);
      return true;
    },
  );
});

test("student cannot claim when weekly hour cap would be exceeded", () => {
  const state = createSeedState(baseNow);
  const student = state.users.find((user) => user.id === "u_student_3");
  student.weeklyHourCap = 1;

  const start = new Date(baseNow.getTime() + 5 * 60 * 60 * 1000);
  const end = new Date(baseNow.getTime() + 7 * 60 * 60 * 1000);
  state.shifts.push(makeOpenShift("shift_cap", start, end, "front_desk", "GSU"));

  assert.throws(
    () => {
      claimShift(state, {
        studentId: "u_student_3",
        shiftId: "shift_cap",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error.code, "INELIGIBLE_SHIFT");
      assert.match(error.details.reasons.join("|"), /Weekly hour cap/);
      return true;
    },
  );
});

test("claim right before start requires immediate confirmation", () => {
  const state = createSeedState(baseNow);
  const start = new Date(baseNow.getTime() + 30 * 60 * 1000);
  const end = new Date(baseNow.getTime() + 90 * 60 * 1000);
  state.shifts.push(makeOpenShift("shift_immediate_confirm", start, end));

  const shift = claimShift(state, {
    studentId: "u_student_1",
    shiftId: "shift_immediate_confirm",
    now: baseNow,
  });

  assert.equal(shift.assignedUserId, "u_student_1");
  assert.equal(shift.confirmationDueAt, baseNow.toISOString());
});

test("swap requires manager approval before ownership changes", () => {
  const state = createSeedState(baseNow);
  const shift = state.shifts.find((entry) => entry.id === "shift_open_2");
  shift.status = "assigned";
  shift.assignedUserId = "u_student_2";
  shift.claimedAt = baseNow.toISOString();
  shift.confirmedAt = null;
  shift.confirmationDueAt = new Date(baseNow.getTime() + 3 * 60 * 60 * 1000).toISOString();

  const request = createSwapRequest(state, {
    requesterId: "u_student_2",
    shiftId: shift.id,
    candidateId: "u_student_1",
    now: baseNow,
  });

  assert.equal(shift.assignedUserId, "u_student_2");

  decideSwapRequest(state, {
    managerId: "u_manager_1",
    swapRequestId: request.id,
    decision: "approve",
    now: baseNow,
  });

  assert.equal(shift.assignedUserId, "u_student_1");
});

test("drop requires manager approval and approved drop reopens shift", () => {
  const state = createSeedState(baseNow);
  const shift = state.shifts.find((entry) => entry.id === "shift_assigned_pending");

  const request = createDropRequest(state, {
    requesterId: "u_student_1",
    shiftId: shift.id,
    now: baseNow,
  });

  assert.equal(shift.assignedUserId, "u_student_1");
  assert.equal(shift.status, "assigned");

  decideDropRequest(state, {
    managerId: "u_manager_1",
    dropRequestId: request.id,
    decision: "approve",
    now: baseNow,
  });

  assert.equal(shift.status, "open");
  assert.equal(shift.assignedUserId, null);
});

test("reminders send in-app + email, and SMS only when opted in", () => {
  const state = createSeedState(baseNow);

  const firstRun = runReminderJob(state, { now: baseNow, windowHours: 24 });
  assert.equal(firstRun.remindersSent >= 1, true);

  const firstStudentNotifications = state.notifications.filter((entry) => entry.userId === "u_student_1");
  const firstStudentEmails = state.emailLog.filter((entry) => entry.userId === "u_student_1");
  const firstStudentSms = state.smsLog.filter((entry) => entry.userId === "u_student_1");

  assert.equal(firstStudentNotifications.length >= 1, true);
  assert.equal(firstStudentEmails.length >= 1, true);
  assert.equal(firstStudentSms.length, 0);

  setSmsOptIn(state, { userId: "u_student_1", smsOptIn: true });
  state.shifts.push(
    {
      ...makeOpenShift(
        "shift_sms_reminder",
        new Date(baseNow.getTime() + 20 * 60 * 60 * 1000),
        new Date(baseNow.getTime() + 22 * 60 * 60 * 1000),
        "library",
        "Mugar",
      ),
      status: "assigned",
      assignedUserId: "u_student_1",
      claimedAt: baseNow.toISOString(),
      confirmationDueAt: new Date(baseNow.getTime() + 18 * 60 * 60 * 1000).toISOString(),
    },
  );

  runReminderJob(state, {
    now: new Date(baseNow.getTime() + 13 * 60 * 60 * 1000),
    windowHours: 24,
  });

  const smsAfterOptIn = state.smsLog.filter((entry) => entry.userId === "u_student_1");
  assert.equal(smsAfterOptIn.length >= 1, true);
});

test("attendance updates dashboard no-show metrics", () => {
  const state = createSeedState(baseNow);
  upsertAttendance(state, {
    managerId: "u_manager_1",
    shiftId: "shift_assigned_pending",
    studentId: "u_student_1",
    mark: "no_show",
    now: baseNow,
  });

  const dashboard = getManagerDashboard(state, "u_manager_1", baseNow);
  assert.equal(dashboard.metrics.noShowCount, 1);
  assert.equal(dashboard.metrics.noShowRate, 1);
});

test("messaging permissions enforce DM and shift-thread rules", () => {
  const state = createSeedState(baseNow);

  const dm = sendMessage(state, {
    senderId: "u_student_1",
    channelType: "dm",
    recipientId: "u_student_2",
    body: "Can you swap with me?",
    now: baseNow,
  });
  assert.equal(dm.channelType, "dm");

  state.users.push({
    id: "u_manager_2",
    name: "Casey Manager",
    role: "manager",
    email: "manager2@bu.edu",
    password: "manager123",
    phone: "+16175550009",
    qualifications: [],
    weeklyHourCap: 0,
    notificationPrefs: { inApp: true, email: true, smsOptIn: false },
  });

  assert.throws(
    () => {
      sendMessage(state, {
        senderId: "u_manager_1",
        channelType: "dm",
        recipientId: "u_manager_2",
        body: "Manager to manager",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error.code, "FORBIDDEN_DM");
      return true;
    },
  );

  assert.throws(
    () => {
      sendMessage(state, {
        senderId: "u_student_3",
        channelType: "shift_thread",
        threadId: "shift_open_2",
        body: "I want this shift thread",
        now: baseNow,
      });
    },
    (error) => {
      assert.equal(error.code, "FORBIDDEN_SHIFT_THREAD");
      return true;
    },
  );
});

test("seed state includes expanded shifts and medium synthetic class schedules", () => {
  const state = createSeedState(baseNow);
  const openCount = state.shifts.filter((shift) => shift.status === "open").length;
  const assignedCount = state.shifts.filter((shift) => shift.status === "assigned").length;
  const completedCount = state.shifts.filter((shift) => shift.status === "completed").length;

  assert.equal(state.shifts.length >= 10, true);
  assert.equal(openCount >= 4, true);
  assert.equal(assignedCount >= 5, true);
  assert.equal(completedCount >= 1, true);

  for (const studentId of ["u_student_1", "u_student_2", "u_student_3"]) {
    const slots = getStudentAvailability(state, studentId);
    assert.equal(slots.length >= 8 && slots.length <= 12, true);
  }
});

test("staffing copilot ranks urgent unconfirmed shifts above confirmed shifts", () => {
  const state = createSeedState(baseNow);
  const dashboard = getManagerDashboard(state, "u_manager_1", baseNow);
  const urgent = dashboard.staffingCopilot.items.find((item) => item.shiftId === "shift_assigned_pending");
  const confirmed = dashboard.staffingCopilot.items.find((item) => item.shiftId === "shift_assigned_confirmed_1");

  assert.ok(urgent);
  assert.ok(confirmed);
  assert.equal(urgent.fillRiskScore > confirmed.fillRiskScore, true);
  assert.equal(urgent.recommendedActions.some((action) => action.type === "nudge_assigned"), true);
});

test("nudge assigned action sends outreach and enforces cooldown", () => {
  const state = createSeedState(baseNow);
  const first = runStaffingNudgeAssigned(state, {
    managerId: "u_manager_1",
    shiftId: "shift_assigned_pending",
    now: baseNow,
  });

  assert.equal(first.sentCount, 1);
  assert.equal(first.targets[0], "u_student_1");
  assert.equal(state.notifications.some((entry) => entry.kind === "staffing_nudge" && entry.userId === "u_student_1"), true);

  assert.throws(
    () => {
      runStaffingNudgeAssigned(state, {
        managerId: "u_manager_1",
        shiftId: "shift_assigned_pending",
        now: new Date(baseNow.getTime() + 30 * 60 * 1000),
      });
    },
    (error) => {
      assert.equal(error.code, "STAFFING_ACTION_COOLDOWN");
      return true;
    },
  );
});

test("nudge candidates action targets eligible users and honors sms opt-in", () => {
  const state = createSeedState(baseNow);
  const smsBefore = state.smsLog.length;
  const result = runStaffingNudgeCandidates(state, {
    managerId: "u_manager_1",
    shiftId: "shift_open_2",
    candidateIds: ["u_student_2"],
    now: baseNow,
  });

  assert.equal(result.sentCount, 1);
  assert.equal(result.targets[0], "u_student_2");
  assert.equal(state.notifications.some((entry) => entry.kind === "staffing_nudge" && entry.userId === "u_student_2"), true);
  assert.equal(state.smsLog.length, smsBefore + 1);
});
