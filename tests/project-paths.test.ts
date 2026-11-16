import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_FOLDER,
  DATASET_FOLDER,
  fromProjectRelative,
  relocateProjectFolder,
  toProjectRelative
} from '../src/main/fs-paths'

/**
 * Settings and profiles store the project's own folders relative to it, so a
 * moved or re-cloned project keeps working; these pin that conversion.
 */

const root = '/work/RebelTools/rebel-lerobot-gui'

describe('toProjectRelative', () => {
  it('stores a folder inside the project relative to it', () => {
    expect(toProjectRelative(`${root}/calibration`, root)).toBe('calibration')
    expect(toProjectRelative(`${root}/data/me`, root)).toBe('data/me')
    expect(toProjectRelative(root, root)).toBe('.')
  })
  it('keeps a folder outside the project absolute', () => {
    expect(toProjectRelative('/mnt/datasets', root)).toBe('/mnt/datasets')
    expect(toProjectRelative('/work/RebelTools/rebel-lerobot-gui-old/data', root)).toBe(
      '/work/RebelTools/rebel-lerobot-gui-old/data'
    )
  })
})

describe('fromProjectRelative', () => {
  it('resolves relative folders against the project, and leaves absolute ones', () => {
    expect(fromProjectRelative('calibration', root)).toBe(`${root}/calibration`)
    expect(fromProjectRelative('/mnt/datasets', root)).toBe('/mnt/datasets')
  })
  it('round-trips', () => {
    for (const path of [`${root}/data`, '/elsewhere/cal']) {
      expect(fromProjectRelative(toProjectRelative(path, root), root)).toBe(path)
    }
  })
})

describe('relocateProjectFolder', () => {
  const nothingExists = (): boolean => false
  const everythingExists = (): boolean => true

  it("repairs a folder left behind by the project's old location", () => {
    const old = '/work/rebel-lerobot-gui/calibration'
    expect(relocateProjectFolder(old, root, CALIBRATION_FOLDER, nothingExists)).toBe('calibration')
    // The old app recreated it on every launch, so it may well still exist.
    expect(relocateProjectFolder(old, root, CALIBRATION_FOLDER, everythingExists)).toBe('calibration')
  })
  it('moves datasets from the old samples folder to data', () => {
    expect(
      relocateProjectFolder('/work/rebel-lerobot-gui/samples', root, DATASET_FOLDER, nothingExists, ['samples'])
    ).toBe('data')
    expect(relocateProjectFolder(`${root}/samples`, root, DATASET_FOLDER, everythingExists, ['samples'])).toBe(
      'data'
    )
  })
  it('leaves a real folder elsewhere alone, even with a matching name', () => {
    expect(relocateProjectFolder('/mnt/lab/calibration', root, CALIBRATION_FOLDER, everythingExists)).toBe(
      '/mnt/lab/calibration'
    )
    expect(relocateProjectFolder('/mnt/lab/arms', root, CALIBRATION_FOLDER, nothingExists)).toBe('/mnt/lab/arms')
  })
  it('turns an absolute path inside the project into its relative form', () => {
    expect(relocateProjectFolder(`${root}/calibration`, root, CALIBRATION_FOLDER, everythingExists)).toBe(
      'calibration'
    )
  })
  it('falls back to the default when nothing is stored', () => {
    expect(relocateProjectFolder('', root, DATASET_FOLDER)).toBe('data')
  })
})
