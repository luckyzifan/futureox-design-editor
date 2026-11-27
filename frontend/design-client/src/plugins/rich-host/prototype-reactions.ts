import type { Interaction, PrototypeAction, PrototypeEasing } from '../../prototype'
import { resolvePrototypeMotion } from '../../prototype-motion'

const easingTypes: Partial<Record<PrototypeEasing, string>> = {
  linear: 'LINEAR', 'ease-in': 'EASE_IN', 'ease-out': 'EASE_OUT', 'ease-in-out': 'EASE_IN_AND_OUT',
}

function triggerOf(event: Interaction) {
  switch (event.trigger) {
    case 'click': return { type: 'ON_CLICK' }
    case 'hover': return { type: 'MOUSE_ENTER', delay: 0, deprecatedVersion: false }
    case 'leave': return { type: 'MOUSE_LEAVE', delay: 0, deprecatedVersion: false }
    case 'after-delay': return { type: 'AFTER_TIMEOUT', timeout: event.delayMs ?? 0 }
  }
}

function navigationOf(action: PrototypeAction) {
  if (action.kind !== 'navigate' || !action.target || action.transitionDurationVar ||
      action.transitionEasingVar || action.transitionResetInteractiveComponents ||
      action.mediaAction || action.mediaSkipByAmount !== undefined || action.mediaSkipToTime !== undefined) return
  const motion = resolvePrototypeMotion(action, action.durationMs, action.easingCurve)
  let transition = null
  if (motion.durationMs > 0 && action.transitionStyle !== 'none') {
    const easing = motion.easing && easingTypes[motion.easing]
    if (!easing || (action.transitionStyle && action.transitionStyle !== 'dissolve') ||
        (!action.transitionStyle && action.transitionShouldSmartAnimate === false)) return
    transition = {
      type: action.transitionStyle === 'dissolve' ? 'DISSOLVE' : 'SMART_ANIMATE',
      duration: motion.durationMs / 1000, easing: { type: easing },
    }
  }
  return {
    type: 'NODE', destinationId: action.target, navigation: 'NAVIGATE', transition,
    preserveScrollPosition: action.transitionPreserveScroll === true && action.transitionResetScrollPosition !== true,
  }
}

/** Export whole representable interactions: changing the action list changes the reaction. */
export function readNavigationReactions(events: readonly Interaction[]) {
  return events.flatMap(event => {
    if (event.condition || !event.actions.length) return []
    const actions = event.actions.map(navigationOf)
    if (!actions.every(action => action !== undefined)) return []
    return [{ trigger: triggerOf(event), actions, action: actions[0] }]
  })
}
