# Repository brief: shop at 8508ce5b8d07 (for intake, focused on this Story)

## What exists
- shop: 11 code files in typescript (7 files), typescriptreact (4 files); JSX, React, React Router, Vitest; 2 entry points, 9 rules in code, 6 tests. (commit 8508ce5b8d07)
- build: `npm run build` (vite build) (package.json:2)
- test: `npm test` (vitest run) (package.json:2)

## Rules that apply
- shipping: when `subtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS` → returns `0`. Not documented, enforced, tested. (pricing.ts:13)
- total: computes `subtotal(cart) - couponDiscount(cart, code, isMember) + shipping(cart)`. Not documented, enforced, tested. (pricing.ts:29)
- WORK-1:AC-001: A shopper who is not a member cannot use the VIP20 coupon. Documented; no code enforcing it was found. (spec.md › WORK-1:AC-001)
- couponDiscount: when `code === 'VIP20'` and `!isMember` → refuses "VIP20 is for members only". Not documented, enforced, tested. (pricing.ts:22)
- couponDiscount: when `code === 'SAVE10' && base >= 3000` → returns `Math.round(base * 0.1)`. Not documented, enforced, tested. (pricing.ts:20)

## Contracts
- Calls GET /products via request (orders.ts:14)
- Calls POST /orders via request (orders.ts:7)

- … 4 more: singularity-flow wm brief --phase intake

Read without a model from the committed source. Open the cited lines before relying on a detail.
