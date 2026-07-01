# SquadUp API

Backend API for **SquadUp**, a sports social app where players find, host, and
join pickup games. This service is built with **NestJS** on top of **MongoDB**
(via Mongoose).

> This repository currently implements the **authentication**, **user
> profile**, and **games** (host / discover / join lifecycle) foundations. Other
> product areas (map/geo search, reputation actions, ratings, push
> notifications) are planned and noted as deferred below.

## Architecture

NestJS organizes the code into feature **modules**, each with a controller
(HTTP layer), a service (business logic), and — where relevant — a Mongoose
schema.

```
src/
  main.ts              # bootstrap: /api prefix, CORS, Swagger
  app.module.ts        # config + MongoDB connection + feature modules
  common/
    decorators/        # @CurrentUser() etc.
    validation/        # validateDto() — explicit, in-service validation
  auth/                # register/login, JWT strategy + guard, DTOs
  users/               # User schema, profile endpoints
  games/               # Game schema, hosting/discovery/roster endpoints
```

**Auth flow**

- Passwords are hashed with **Argon2id** (`argon2`) at registration and verified
  at login.
- **Password policy** (enforced on `POST /auth/register`): **8–20 characters**,
  with at least **one uppercase letter, one lowercase letter, one number, and one
  symbol** (any non-alphanumeric character).
- **Breach check:** registration also rejects passwords found in the
  [Have I Been Pwned](https://haveibeenpwned.com/Passwords) corpus, using the
  **range (k-anonymity) API** — only the first 5 characters of the password's
  SHA-1 hash are sent, so the password never leaves the server. The check
  **fails open** (a HIBP outage won't block signups) and can be disabled with
  `PWNED_PASSWORD_CHECK=false`.
- A successful register/login returns a **JWT** (`@nestjs/jwt`) signed with
  `JWT_SECRET`.
- Protected routes use a Passport **JWT strategy** + `JwtAuthGuard`. The strategy
  loads the user from the token's `sub` claim and rejects **soft-deleted** or
  **suspended** accounts, so a still-valid token can't outlive access.
- There is **no** global `ValidationPipe`. Each service validates its own
  payload explicitly via the `validateDto` helper
  (`common/validation/validate-dto.ts`), which runs the DTO's `class-validator`
  decorators and rejects unknown properties.

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
| `preferred_positions` | Map<string,string> | preferred position per sport, one each (e.g. `{ soccer: 'GK' }`); positions are free text |
| `games_created` | ObjectId[] | refs to `Game` this user hosts |
| `games_joined` | ObjectId[] | refs to `Game` this user has joined |
| `deleted_at` | Date \| null | soft-delete marker |
| `createdAt` / `updatedAt` | Date | timestamps |

## Game model

| Field | Type | Notes |
|---|---|---|
| `host` | ObjectId | ref to `User`; auto-added to `participants` on creation |
| `sport` | string | required |
| `description` | string | optional |
| `location` | string | required (human-readable place) |
| `start_time` | Date | required; must be in the future at creation |
| `latitude` / `longitude` | number | stored now; radius/"nearby" search *(deferred)* |
| `min_players` | number | active roster hitting this flips status to `confirmed` |
| `max_players` | number | active roster hitting this flips status to `locked` |
| `status` | enum | `open` \| `confirmed` \| `locked` \| `completed` \| `cancelled` (`completed`/`cancelled` are terminal) |
| `participants` | Participant[] | inline roster of `{ user, status: 'joined' \| 'cancelled', joined_at }` |
| `photo_url` | string | optional |
| `createdAt` / `updatedAt` | Date | timestamps |

**Lifecycle.** The host auto-joins as the first participant. Status is recomputed
from the count of `joined` participants after every join/leave: `open →
confirmed` at `min_players`, `→ locked` at `max_players`. Leaving marks the
participant `cancelled` (roster history is kept) rather than removing them. Only
the host may edit, cancel, or complete a game; the acting user always comes from
the JWT, never the request body.

## Endpoints

All routes are prefixed with `/api`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account; returns `{ token, user }` |
| POST | `/auth/login` | — | Log in; returns `{ token, user }` |
| GET | `/users/me` | JWT | Authenticated user's full profile |
| PATCH | `/users/me` | JWT | Update `first_name` / `last_name` / `username` / `preferred_positions` |
| DELETE | `/users/me` | JWT | Soft-delete own account (record retained, login blocked) |
| GET | `/users/:id` | JWT | Another player's **public** profile (no email/password) |
| POST | `/games` | JWT | Host a game (host auto-joins the roster) |
| GET | `/games` | JWT | Discover games; filter by `sport`, `status`, `upcoming` |
| GET | `/games/mine` | JWT | Games you host or actively play in; filter by `role`, `status` |
| GET | `/games/:id` | JWT | A single game |
| PATCH | `/games/:id` | JWT | Edit a game (**host only**) |
| POST | `/games/:id/join` | JWT | Join a game's roster |
| POST | `/games/:id/leave` | JWT | Leave a game's roster (host must cancel instead) |
| POST | `/games/:id/cancel` | JWT | Cancel a game (**host only**, terminal) |
| POST | `/games/:id/complete` | JWT | Mark a game completed (**host only**, terminal) |

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
   | `PWNED_PASSWORD_CHECK` | Optional; set to `false` to disable the Have I Been Pwned breach check (default enabled) |
3. Run it:
   ```bash
   npm run start:dev   # watch mode
   npm run build       # compile to dist/
   npm run start:prod  # run compiled build
   ```

The API listens on `http://localhost:${PORT}` with docs at `/api/docs`.

## `models/` (reference only)

The `models/` directory holds legacy **Express/Mongoose** schemas from earlier
work (Game, Rating, Report, Notification, DeviceToken, GameFollow,
EmailVerificationCode). They are **not** used by the NestJS app and are kept only
as reference for porting those features into NestJS `@Schema` classes later.
`Game` has since been ported to `src/games/schemas/game.schema.ts` (same fields
and collection); the rest remain reference only.

> Note: the legacy `User` model there included a skill-rating system and a
> boolean `account_status`. This service intentionally diverges — **no skill
> ratings**, an `account_status` enum, and `reputation` defaulting to 5.0 — see
> the User model table above. This divergence should be reconciled with the team.
