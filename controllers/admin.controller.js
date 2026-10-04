import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as adminService from "../services/admin.service.js";

const listQueue = asyncHandler(async (req, res) => {
  const result = await adminService.listReviewQueue({
    actorSub: req.user.id,
    rawFilters: req.query ?? {},
  });
  return ApiResponse.success(res, "Review queue fetched", result);
});

const getDetail = asyncHandler(async (req, res) => {
  const detail = await adminService.getAdminClaimDetail({
    claimId: req.params.claimId,
    actorSub: req.user.id,
  });
  return ApiResponse.success(res, "Claim detail fetched", detail);
});

const overrideClaim = asyncHandler(async (req, res) => {
  const result = await adminService.overrideClaim({
    claimId: req.params.claimId,
    actorSub: req.user.id,
    actorEmail: req.user.email ?? null,
    toState: req.body.toState,
    reason: req.body.reason,
    adminNote: req.body.adminNote,
    approverSub: req.body.approverSub,
    overrideKey: req.body.overrideKey,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(
    res,
    result.idempotent ? "Override already applied" : "Claim overridden",
    result
  );
});

const dashboard = asyncHandler(async (req, res) => {
  const result = await adminService.getDashboard({
    rangeDays: req.query.rangeDays,
  });
  return ApiResponse.success(res, "Dashboard metrics computed", result);
});

const investigation = asyncHandler(async (req, res) => {
  const result = await adminService.getInvestigation({
    rangeDays: req.query.rangeDays,
  });
  return ApiResponse.success(res, "Investigation view computed", result);
});

const getUsers = asyncHandler(async (req, res) => {
  const { page, limit, search, status, role } = req.query;
  const result = await adminService.listUsers({ page, limit, search, status, role });
  return ApiResponse.success(res, "Users fetched", result);
});

const getUser = asyncHandler(async (req, res) => {
  const result = await adminService.getUserById(req.params.id);
  return ApiResponse.success(res, "User details fetched", result);
});

const changeUserStatus = asyncHandler(async (req, res) => {
  const user = await adminService.updateUserStatus({
    userId: req.params.id,
    status: req.body.status,
    requesterCognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "User status updated", { user });
});

export {
  listQueue,
  getDetail,
  overrideClaim,
  dashboard,
  investigation,
  getUsers,
  getUser,
  changeUserStatus,
};
