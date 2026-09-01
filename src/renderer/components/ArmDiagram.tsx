import { STS3215_MAX_TICK } from '@shared/devices'
import type { DeviceRole } from '@shared/devices'
import { DIAGRAM, GUTTER_FRACTION, anchorPoint, anchorsFor, armImageFor, leaderPoints } from '@shared/motor-layout'
import type { BusSnapshot, MotorState } from '@shared/types'
import type { ReactNode } from 'react'
import { MotorCallout } from './MotorCallout'

/**
 * The annotated arm view: the render in the middle, indicators pointing at each
 * motor, and information cards in the gutters on both sides.
 *
 * The SVG and the HTML cards share one coordinate system (DIAGRAM), so the
 * leader lines land on the cards without measuring the DOM: a line stops at
 * `DIAGRAM.leaderStop`, and the card at the same normalized `calloutY` starts
 * exactly there.
 */
export function ArmDiagram({
  role,
  snapshot,
  selected,
  onSelect
}: {
  role: DeviceRole
  snapshot: BusSnapshot
  selected: string | null
  onSelect: (motor: string) => void
}): ReactNode {
  const anchors = anchorsFor(role)
  const byName = new Map(snapshot.motors.map((m) => [m.name, m]))
  const gutterPct = `${GUTTER_FRACTION * 100}%`

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl bg-plate"
      style={{ aspectRatio: `${DIAGRAM.width} / ${DIAGRAM.height}`, maxWidth: 1180 }}
    >
      <svg
        viewBox={`0 0 ${DIAGRAM.width} ${DIAGRAM.height}`}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`${role === 'robot' ? 'Follower' : 'Leader'} arm with motor indicators`}
      >
        <defs>
          {/* A soft floor shadow so the render does not float on the panel. */}
          <radialGradient id="arm-floor" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#4cc4ff" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#4cc4ff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse
          cx={DIAGRAM.image.x + DIAGRAM.image.width * 0.55}
          cy={DIAGRAM.height * 0.845}
          rx={DIAGRAM.image.width * 0.34}
          ry={DIAGRAM.height * 0.035}
          fill="url(#arm-floor)"
        />

        <image
          href={`arm://${armImageFor(role)}`}
          x={DIAGRAM.image.x}
          y={DIAGRAM.image.y}
          width={DIAGRAM.image.width}
          height={DIAGRAM.image.height}
          preserveAspectRatio="xMidYMid meet"
          className="arm-render"
        />

        {anchors.map((anchor) => {
          const motor = byName.get(anchor.motor)
          const point = anchorPoint(anchor)
          const isSelected = selected === anchor.motor
          const tone = indicatorTone(motor, isSelected)

          return (
            <g
              key={anchor.motor}
              className="cursor-pointer"
              onClick={() => onSelect(anchor.motor)}
              role="button"
              aria-label={`Select ${motor?.label ?? anchor.motor}`}
            >
              {/* Leader line from the joint out to its card. */}
              <polyline
                points={leaderPoints(anchor)}
                fill="none"
                className={tone.line}
                strokeWidth={isSelected ? 3.5 : 2}
                strokeLinejoin="round"
                strokeDasharray={motor?.online ? undefined : '9 7'}
              />
              {/* Halo makes the dot readable over both the white and black arm. */}
              <circle cx={point.x} cy={point.y} r={isSelected ? 22 : 16} className={tone.halo} />
              <circle
                cx={point.x}
                cy={point.y}
                r={isSelected ? 11 : 8}
                className={`${tone.dot} stroke-plate`}
                strokeWidth={2.5}
              />
              {/* shell-950 inverts with the dot colours, so the number stays legible. */}
              <text
                x={point.x}
                y={point.y + 5.5}
                textAnchor="middle"
                className="fill-shell-950 select-none font-mono"
                fontSize={isSelected ? 14 : 11}
                fontWeight={700}
              >
                {motor?.id ?? '?'}
              </text>
              {/* Generous invisible hit area — the dots are small at low zoom. */}
              <circle cx={point.x} cy={point.y} r={30} fill="transparent" />
            </g>
          )
        })}
      </svg>

      {anchors.map((anchor) => {
        const motor = byName.get(anchor.motor)
        if (!motor) return null
        return (
          <div
            key={anchor.motor}
            className="absolute"
            style={{
              [anchor.side]: 0,
              width: gutterPct,
              top: `${anchor.calloutY * 100}%`,
              transform: 'translateY(-50%)'
            }}
          >
            <MotorCallout
              motor={motor}
              align={anchor.side}
              selected={selected === anchor.motor}
              onSelect={() => onSelect(anchor.motor)}
            />
          </div>
        )
      })}
    </div>
  )
}

/** Utility classes rather than literals, so the indicators follow the theme. */
function indicatorTone(
  motor: MotorState | undefined,
  selected: boolean
): { dot: string; line: string; halo: string } {
  if (selected) {
    return { dot: 'fill-accent-400', line: 'stroke-accent-400', halo: 'fill-accent-400/28' }
  }
  if (motor?.online) {
    return { dot: 'fill-live-400', line: 'stroke-live-400/65', halo: 'fill-live-400/16' }
  }
  if (motor && motor.rangeMin !== null) {
    // Known from a calibration file, but not answering on the bus.
    return { dot: 'fill-warn-400', line: 'stroke-warn-400/50', halo: 'fill-warn-400/14' }
  }
  return { dot: 'fill-ink-500', line: 'stroke-ink-500/45', halo: 'fill-ink-500/14' }
}

/**
 * Fraction of travel a position sits at, for the callout's bar.
 * Falls back to the full encoder span when the motor has no limits yet.
 */
export function travelFraction(motor: MotorState): number | null {
  if (motor.position === null) return null
  const min = motor.rangeMin ?? 0
  const max = motor.rangeMax ?? STS3215_MAX_TICK
  if (max <= min) return null
  return Math.min(1, Math.max(0, (motor.position - min) / (max - min)))
}
