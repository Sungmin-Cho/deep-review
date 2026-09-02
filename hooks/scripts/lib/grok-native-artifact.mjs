// The native-launcher predicate is shared by the coordinator (refuse before
// privacy) and the contained-runner adapter (belt before spawn). It lives here
// so neither the coordinator nor the supervisor imports the other for it.
export function isNativeGrokLauncher(chain) {
  if (!chain || typeof chain !== 'object') return false;
  if (chain.prepared_kind !== 'direct' || chain.shebang !== null) return false;
  return chain.posix_executable_type === null || /^native-/u.test(String(chain.posix_executable_type));
}
