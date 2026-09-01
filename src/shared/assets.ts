/**
 * URLs for files served out of the app's `assets` folder.
 *
 * `arm://` is a custom scheme registered in the main process (see
 * `registerAssetProtocol`); it works the same in dev and once packaged, where
 * the folder moves to `process.resourcesPath`.
 */

export const ASSET_SCHEME = 'arm'

/**
 * `arm://` URL for an asset, escaping each path segment.
 *
 * The brand exports carry `@3x` in their names, and an unescaped `@` in a URL's
 * authority is userinfo — `arm://mark@3x.png` would parse `3x.png` as the host.
 * Encoding per segment keeps the slashes as separators and everything else
 * literal, whatever the filename looks like.
 */
export function assetUrl(path: string): string {
  return `${ASSET_SCHEME}://${path.split('/').map(encodeURIComponent).join('/')}`
}
