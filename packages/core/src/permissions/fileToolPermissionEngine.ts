export {
  expandSymlinkPaths,
  hasSuspiciousWindowsPathPattern,
  isPathInWorkingDirectories,
  isSensitiveFilePath,
  isWriteProtectedPath,
  resolveLikeCliPath,
} from '@kode/permissions/fileToolPermissionEngine'

export { matchPermissionRuleForPath } from '@kode/permissions/fileToolPermissionEngine'

export {
  getPlanFileWritePrivilegeForContext,
  getSpecialAllowedWriteReason,
  getSpecialAllowedReadReason,
  getWriteSafetyCheckForPath,
  isSpecialAllowedWritePathForContext,
  isPlanFileForContext,
} from './fileToolPermissionEngine/plan'

export { suggestFilePermissionUpdates } from '@kode/permissions/fileToolPermissionEngine'
