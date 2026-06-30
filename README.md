# SquadUp API

Backend API for **SquadUp**, a sports social app where players find, host, and
join pickup games. This service is built with **NestJS** on top of **MongoDB**
(via Mongoose).

> This repository currently implements the **authentication** and **user
> profile** foundation. Other product areas (games/feed, map, reputation
> actions, push notifications) are planned and noted as deferred below.

## Architecture

NestJS organizes the code into feature **modules**, each with a controller
(HTTP layer), a service (business logic), and — where relevant — a Mongoose
schema.

```
src/
  main.ts              # bootstrap: /api prefix, validation, CORS, Swagger
  app.module.ts        # config + MongoDB connection + feature modules
  common/
    decorators/        # @CurrentUser() etc.
  auth/                # register/login, JWT strategy + guard, DTOs
  users/               # User schema, profile endpoints
```

**Auth flow**

- Passwords are hashed with **Argon2id** (`argon2`) at registration and verified
  at login.
- A successful register/login returns a **JWT** (`@nestjs/jwt`) signed with
  `JWT_SECRET`.
- Protected routes use a Passport **JWT strategy** + `JwtAuthGuard`. The strategy
  loads the user from the token's `sub` claim and rejects **soft-deleted** or
  **suspended** accounts, so a still-valid token can't outlive access.
- Requests are validated against DTOs by a global `ValidationPipe`
  (`class-validator`).

## User model

| Field | Type | Notes |
|---|---|---|
| `first_name`, `last_name` | string | required |
| `username` | string | required, **unique** |
| `email` | string | required, **unique** |
| `password` | string | Argon2id hash, never returned (`select: false`) |
| `reputation` | float | 0.0–5.0, starts at **5.0**; set by post-match ratings |
| `no_show_count` | number | starts at 0 |
| `is_flaker` | boolean | derived later from `no_show_count` *(deferred)* |
| `reputation_reports` | number | trash-talk/dirty-play reports; suspend-at-10 logic *(deferred)* |
| `account_status` | enum | `pending` \| `active` \| `suspended` (single source of truth for suspension; `pending` = school email unverified) |
| `games_created` | ObjectId[] | refs to `Game` *(wired with Game schema later)* |
| `games_joined` | ObjectId[] | refs to `Game` *(wired with Game schema later)* |
| `deleted_at` | Date \| null | soft-delete marker |
| `createdAt` / `updatedAt` | Date | timestamps |

## Endpoints

All routes are prefixed with `/api`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account; returns `{ token, user }` |
| POST | `/auth/login` | — | Log in; returns `{ token, user }` |
| GET | `/users/me` | JWT | Authenticated user's full profile |
| PATCH | `/users/me` | JWT | Update `first_name` / `last_name` / `username` |
| DELETE | `/users/me` | JWT | Soft-delete own account (record retained, login blocked) |
| GET | `/users/:id` | JWT | Another player's **public** profile (no email/password) |

Interactive, testable docs (with a Bearer-token "Authorize" button) are served
by **Swagger** at **`/api/docs`**.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` from the template and fill it in:
   ```bash
   cp .env.example .env
   ```
   | Var | Description |
   |---|---|
   | `MONGO_URI` | MongoDB connection string |
   | `JWT_SECRET` | Secret used to sign JWTs |
   | `JWT_EXPIRES_IN` | Token lifetime, e.g. `1d` |
   | `PORT` | HTTP port (default `5000`) |
3. Run it:
   ```bash
   npm run start:dev   # watch mode
   npm run build       # compile to dist/
   npm run start:prod  # run compiled build
   ```

The API listens on `http://localhost:${PORT}` with docs at `/api/docs`.

## Contributing

See [`CLAUDE.md`](./CLAUDE.md) and [`constitution.md`](./constitution.md) for
branching, commit, and PR conventions.
