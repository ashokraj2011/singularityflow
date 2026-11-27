# Repository brief: shop at 8508ce5b8d07 (for verification, focused on this Story)

## Rules that apply
- shipping: when `subtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS` → returns `0`. Not documented, enforced, tested. (pricing.ts:13)
- total: computes `subtotal(cart) - couponDiscount(cart, code, isMember) + shipping(cart)`. Not documented, enforced, tested. (pricing.ts:29)
- WORK-1:AC-001: A shopper who is not a member cannot use the VIP20 coupon. Documented; no code enforcing it was found. (spec.md › WORK-1:AC-001)
- couponDiscount: when `code === 'VIP20'` and `!isMember` → refuses "VIP20 is for members only". Not documented, enforced, tested. (pricing.ts:22)
- couponDiscount: when `code === 'SAVE10' && base >= 3000` → returns `Math.round(base * 0.1)`. Not documented, enforced, tested. (pricing.ts:20)
- subtotal: computes `cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0)`. Not documented, enforced, tested. (pricing.ts:9)
- cartReducer: when `action.type is 'setQuantity'` → does `const quantity = Math.min(Math.max(action.quantity, 0), MAX_QUANTITY_PER_LINE)`. Not documented, enforced, tested. (cart.ts:24)

## Risks
- (changed by this Story) shipping: reached by 2 entry points (pricing.ts:12)
- couponDiscount: test and code disagree: the test title says "more than" (strict), the code uses >= (pricing.ts)
- couponDiscount: reached by 3 entry points, called from 2 places, 4 rules (pricing.ts:17)
- subtotal: reached by 3 entry points, called from 3 places (pricing.ts:8)
- total: reached by 2 entry points (pricing.ts:28)
- CheckoutForm.handleSubmit: reached by 1 entry point, no test reaches it (CheckoutForm.tsx:13)

## Flows
- change in CheckoutForm → total → couponDiscount (and 2 helpers: subtotal, shipping); refuses 1 way; 7 rules on the way; may fail with Error (CheckoutForm.tsx:8)
- submit in CheckoutForm → total → couponDiscount (and 2 helpers: subtotal, shipping); refuses 1 way; 7 rules on the way; may fail with Error (CheckoutForm.tsx:8)

## What a change touches
- shipping (changed): called by total; on change in CheckoutForm, submit in CheckoutForm; 1 rule; tested by pricing.test.ts (pricing.ts:12)

- … 4 more: singularity-flow wm brief --phase verification

Not known: calls are matched by name (no semantic pack is warmed); no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
