# Admin Panel Integration

This backend branch includes the administrative user-management layer while preserving the existing claim-review/exception workflow.

## Admin capabilities

- Admin dashboard: claim/operations metrics plus user, farm-profile, chat-session, and recent-user statistics.
- User listing with pagination, search, role filter, and status filter.
- User detail view with farm profile and chat-session count.
- Activate/block user accounts.
- Prevent an administrator from blocking their own account.
- Blocked users are denied access by the authentication middleware.
- Admin role is stored server-side in MongoDB and is never accepted from a client request body.

## Routes

All routes below require authentication and the `admin` role through `app.js`.

- `GET /admin/dashboard`
- `GET /admin/users`
- `GET /admin/users/:id`
- `PATCH /admin/users/:id/status`
- Existing claim-admin routes remain available under `/admin/claims` and `/admin/investigation`.

## Create an administrator

1. Let the administrator sign in normally once so a `User` record exists.
2. Run:

```bash
npm run seed:admin -- admin@example.com
```

The script sets that user's `role` to `admin` and `status` to `active`.

## Security notes

- Never commit `.env` or database credentials.
- `role` and `status` are controlled by the backend.
- Authentication checks the current MongoDB account status on every request.
- Invalid user IDs and invalid account-status values return client errors instead of database cast errors.

## Verification

Before publishing:

```bash
npm ci
npm test
```

Also run:

```bash
git diff --check
git status
```

Only commit the intended source/documentation changes to `admin-panel-integration`.
