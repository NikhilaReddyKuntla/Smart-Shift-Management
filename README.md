# BU Student Shift Management MVP

A Vercel-ready web MVP for Boston University student employee shift operations.

## Included MVP capabilities

- Role-based access: manager + student
- Shift release and claim with eligibility rules
- Swap and drop requests with manager approvals
- Student class schedule busy-slot grid (30-minute intervals)
- Shift confirmation and reminder flow (in-app + email, optional SMS)
- Attendance marking (`present`, `no_show`, `excused`) and no-show dashboard metrics
- Communication channels: department group, direct messages, shift threads
- Separate manager and student dashboards

## Tech stack

- Backend: Node.js + Express (serverless-compatible entry at `api/index.js`)
- Frontend: static HTML/CSS/JS in `public/`
- Data: in-memory seeded store (for MVP/demo)
- Tests: Node built-in test runner (`node --test`)

## Run locally

```bash
npm install
npm run start
```

Open: [http://localhost:3000](http://localhost:3000)

## Demo login credentials

Shown directly on the login page (seeded users).

- Manager: `manager@bu.edu` / `manager123`
- Students:
  - `maya@bu.edu` / `student123`
  - `jordan@bu.edu` / `student123`
  - `sam@bu.edu` / `student123`

## Test

```bash
npm test
```

## Deploy to Vercel (with GitHub)

1. Push this project to a GitHub repo.
2. Import the repo in [Vercel](https://vercel.com/new).
3. Framework preset: **Other** (no extra config needed).
4. Deploy.

The API is routed through `/api/index.js` and static UI is served from `public/`.

## Notes for this MVP

- Authentication is demo-level (seeded credentials, header token in browser local storage).
- Data resets when the process restarts (no persistent database yet).
- Designed for one-department pilot scope.
