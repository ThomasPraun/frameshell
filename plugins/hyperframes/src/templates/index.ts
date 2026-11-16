import { appWindow } from "./app-window.js";
import { beforeAfter } from "./before-after.js";
import { bigWord } from "./big-word.js";
import { chatBubble } from "./chat-bubble.js";
import { checklist } from "./checklist.js";
import { codeDiff } from "./code-diff.js";
import { codeMorph } from "./code-morph.js";
import { codeTyping } from "./code-typing.js";
import { commentBox } from "./comment-box.js";
import { comparison } from "./comparison.js";
import { counter } from "./counter.js";
import { deviceFrame } from "./device-frame.js";
import { cursorClick } from "./cursor-click.js";
import { cursorDragDrop } from "./cursor-drag-drop.js";
import { cursorMarquee } from "./cursor-marquee.js";
import { cursorTextSelect } from "./cursor-text-select.js";
import { emphasisMarker } from "./emphasis-marker.js";
import { endCard } from "./end-card.js";
import { freezeCut } from "./freeze-cut.js";
import { glassCard } from "./glass-card.js";
import type { Template } from "./kit.js";
import { kineticHeadline } from "./kinetic-headline.js";
import { logo3d } from "./logo-3d.js";
import { logoLockup } from "./logo-lockup.js";
import { lowerThird } from "./lower-third.js";
import { notificationStack } from "./notification-stack.js";
import { numberWheel } from "./number-wheel.js";
import { productShot } from "./product-shot.js";
import { promptBar } from "./prompt-bar.js";
import { pullBackReveal } from "./pull-back-reveal.js";
import { sceneBackground } from "./scene-background.js";
import { slotRoll } from "./slot-roll.js";
import { tabIndicator } from "./tab-indicator.js";
import { terminal } from "./terminal.js";
import { typingField } from "./typing-field.js";

export { type FontSetup, type Template, type TemplateInput, type TemplateVariable, fontSetup, withComponents } from "./kit.js";
export { type BrandComponent, type ComponentPick, pickComponents, placeFrame, readComponents } from "./components.js";
export { type ThreeTemplate, usesThree } from "./three-kit.js";
export { type BrandTokens, type FontToken, readTokens } from "./tokens.js";

/** The templates `frameshell hyperframes new --template <id>` scaffolds, in the order the docs list them (#466). */
export const TEMPLATES: readonly Template[] = [kineticHeadline, endCard, lowerThird, logoLockup, checklist, comparison, counter, bigWord, cursorClick, cursorDragDrop, cursorMarquee, cursorTextSelect, appWindow, typingField, commentBox, terminal, chatBubble, notificationStack, deviceFrame, sceneBackground, promptBar, glassCard, productShot, emphasisMarker, beforeAfter, pullBackReveal, logo3d, codeTyping, codeDiff, codeMorph, slotRoll, numberWheel, tabIndicator, freezeCut];

/** The template with id `id`, if any. */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
