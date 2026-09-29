import { ROS_TOPICS } from '@shared/ros'
import type { ReactNode } from 'react'
import type { RosPublishState } from '../lib/use-ros-publish'
import { Toggle } from './ui'

const TOPIC_LIST = Object.values(ROS_TOPICS)
  .map((t) => t.name)
  .join(', ')

function where(ros: RosPublishState): string {
  const ns = ros.namespaces.length > 0 ? ros.namespaces.join(' and ') : '/<device name>'
  return `${ns} (${TOPIC_LIST})`
}

/**
 * The "publish to ROS 2" switch beside a panel's start button, and how it is going.
 *
 * `unavailable` is for the places the app cannot publish from yet — a LeRobot
 * command holds the serial port itself, so the app has no readings to send.
 */
export function RosPublishToggle({
  ros,
  unavailable
}: {
  ros: RosPublishState
  unavailable?: string
}): ReactNode {
  if (unavailable) {
    return <Toggle checked={false} onChange={() => undefined} disabled label="Publish to ROS 2" hint={unavailable} />
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Toggle
        checked={ros.enabled}
        onChange={ros.setEnabled}
        label="Publish to ROS 2"
        hint={
          ros.publishing
            ? undefined
            : `While driving, publishes ${where(ros)} to rosbridge at ${ros.url}.`
        }
      />
      {ros.publishing && <RosLine ros={ros} />}
    </div>
  )
}

/** One line of status: connected and how fast, or why not. */
function RosLine({ ros }: { ros: RosPublishState }): ReactNode {
  const dot =
    ros.connection === 'connected'
      ? 'bg-live-400'
      : ros.connection === 'error'
        ? 'bg-danger-400'
        : 'bg-warn-400'
  const text =
    ros.error && ros.connection !== 'connected'
      ? `${ros.error} Retrying…`
      : ros.error
        ? ros.error
        : ros.connection === 'connected'
          ? `${ros.namespaces.join(', ')} · ${ros.rate.toFixed(0)} msg/s`
          : `Connecting to ${ros.url}…`
  return (
    <p className="flex items-start gap-2 pl-10.5 text-xs leading-relaxed text-ink-500">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  )
}

/**
 * The switch squeezed into a panel header, for a start button that lives there.
 */
export function RosPublishChip({ ros }: { ros: RosPublishState }): ReactNode {
  const tone = !ros.enabled
    ? 'border-shell-600 text-ink-500 hover:text-ink-300'
    : !ros.publishing
      ? 'border-accent-600 text-accent-400'
      : ros.connection === 'connected'
        ? 'border-live-600 text-live-400'
        : ros.connection === 'error'
          ? 'border-danger-600 text-danger-400'
          : 'border-warn-600 text-warn-400'
  const title = ros.publishing
    ? ros.error ?? (ros.connection === 'connected' ? `Publishing ${where(ros)}` : `Connecting to ${ros.url}…`)
    : ros.enabled
      ? `Will publish ${where(ros)} to ${ros.url} while the arm is driven. Click to turn off.`
      : `Publish ${where(ros)} to ROS 2 while the arm is driven.`
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ros.enabled}
      title={title}
      onClick={() => ros.setEnabled((on) => !on)}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${tone}`}
    >
      ROS 2 {ros.enabled ? (ros.publishing && ros.connection === 'connected' ? `· ${ros.rate.toFixed(0)}/s` : 'on') : 'off'}
    </button>
  )
}
