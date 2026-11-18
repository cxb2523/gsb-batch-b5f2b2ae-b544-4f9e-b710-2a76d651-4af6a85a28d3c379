import { createVisual, setVisualMode } from './registry.js';

// Swaps every visual in a running game between greybox and models.
// Only the look is replaced. Each outgoing visual hands its state (animation time, hit flash,
// fade alpha, spin/bob phase ...) to its replacement, so gameplay state, drops and broken
// cover are exactly what they were before the switch.
export function switchVisuals(game, mode) {
  setVisualMode(mode);

  // Fighters keep their current animation and playback position, flash, and KO fade alpha.
  for (const f of [game.hero, ...game.enemies]) {
    f.setVisual(createVisual(f.kind));
  }

  // Props: a broken crate stays removed from the scene and out of the collider list; every
  // other prop is rebuilt in place (static props have no state to carry).
  for (const p of game.props) {
    const v = createVisual(p.id);
    v.root.position.copy(p.visual.root.position);
    v.root.rotation.copy(p.visual.root.rotation);
    v.applyState(p.visual.captureState());
    game.scene.remove(p.visual.root);
    p.visual.dispose();
    if (!p.broken) game.scene.add(v.root);   // a broken crate stays gone
    p.visual = v;
  }

  // Food on the ground keeps its spot and its spin/bob phase, and stays a working pickup.
  for (const food of game.pickups) {
    const v = createVisual('food');
    v.root.position.copy(food.visual.root.position);
    v.root.rotation.copy(food.visual.root.rotation);
    v.applyState(food.visual.captureState());
    game.scene.remove(food.visual.root);
    food.visual.dispose();
    game.scene.add(v.root);
    food.visual = v;
  }
}
