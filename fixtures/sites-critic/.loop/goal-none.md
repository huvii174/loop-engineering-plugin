# Goal
Every price the app shows goes through `formatPrice` in `src/money.mjs`, so the
currency format has one home.

## Success criteria (verifiable)
- [ ] C1 every price is formatted by formatPrice
      Done when: no file under `src/` other than `src/money.mjs` calls `.toFixed(2)`, and `node -e "import(\"./src/cart/total.mjs\").then(m=>console.log(m.cartTotal([{price:2,qty:3}])))"` prints `$6.00`
      Evidence: behavior → the node one-liner; the grep below
      Sites: none (only the cart shows prices, so there is no second site)
      Must not: the output format of any price changes

## Tier
tier: small
