import "server-only";

/**
 * 用户勾选「成功后写入新版本」时落库；
 * 若世界**尚无任何已保存版本**，即使未勾选也落库，避免新建世界跑完流水线却白跑。
 */
export function shouldPersistWorldForgeAfterSuccess(
  persistRequested: boolean,
  hasExistingSavedVersion: boolean
): boolean {
  return persistRequested || !hasExistingSavedVersion;
}
