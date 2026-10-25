/**
 * src/cart/cart.test.ts
 *
 * WHAT IT'S FOR
 *   Tests for the shared cart state: repeated additions, quantities, totals in integer cents,
 *   clearing, the shared update mechanism removal uses, and change notifications.
 *
 * OWNER: agent a (cart).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Product } from "../contracts/product";
import type { CartService } from "../contracts/cart";
import { createCart } from "./cart";

const mug: Product = { id: "mug", name: "Mug", description: "A mug", image: "mug.png", priceCents: 1299 };
const tee: Product = { id: "tee", name: "T-shirt", description: "A tee", image: "tee.png", priceCents: 2000 };

describe("cart", () => {
  let cart: CartService;
  beforeEach(() => {
    cart = createCart();
  });

  it("starts empty with a zero total", () => {
    expect(cart.getItems()).toEqual([]);
    expect(cart.getTotalCents()).toBe(0);
  });

  it("adds a new product with quantity 1", () => {
    cart.addItem(mug);
    expect(cart.getItems()).toEqual([{ product: mug, quantity: 1 }]);
  });

  it("increases the quantity when the same product is added again", () => {
    cart.addItem(mug);
    cart.addItem(mug);
    cart.addItem(mug);
    expect(cart.getItems()).toEqual([{ product: mug, quantity: 3 }]);
  });

  it("keeps different products as separate rows in the order first added", () => {
    cart.addItem(tee);
    cart.addItem(mug);
    cart.addItem(tee);
    expect(cart.getItems().map((i) => [i.product.id, i.quantity])).toEqual([
      ["tee", 2],
      ["mug", 1],
    ]);
  });

  it("totals priceCents * quantity in integer cents", () => {
    cart.addItem(mug);
    cart.addItem(mug);
    cart.addItem(tee);
    expect(cart.getTotalCents()).toBe(2 * 1299 + 2000);
    expect(Number.isInteger(cart.getTotalCents())).toBe(true);
  });

  it("rejects non-integer prices", () => {
    expect(() => cart.addItem({ ...mug, priceCents: 12.99 })).toThrow();
    expect(cart.getItems()).toEqual([]);
  });

  it("clearCart empties the cart", () => {
    cart.addItem(mug);
    cart.addItem(tee);
    cart.clearCart();
    expect(cart.getItems()).toEqual([]);
    expect(cart.getTotalCents()).toBe(0);
  });

  it("getItems returns copies that cannot change the cart", () => {
    cart.addItem(mug);
    const items = cart.getItems();
    items[0].quantity = 99;
    items.push({ product: tee, quantity: 1 });
    expect(cart.getItems()).toEqual([{ product: mug, quantity: 1 }]);
  });

  it("updateItems changes the shared state, as removal does", () => {
    cart.addItem(mug);
    cart.addItem(mug);
    cart.addItem(tee);
    cart.updateItems((items) => items.filter((i) => i.product.id !== "mug"));
    expect(cart.getItems()).toEqual([{ product: tee, quantity: 1 }]);
    expect(cart.getTotalCents()).toBe(2000);
  });

  it("updateItems drops items whose quantity falls below 1", () => {
    cart.addItem(mug);
    cart.updateItems((items) => items.map((i) => ({ ...i, quantity: i.quantity - 1 })));
    expect(cart.getItems()).toEqual([]);
  });

  it("notifies subscribers on every change until they unsubscribe", () => {
    const seen: number[] = [];
    const unsubscribe = cart.subscribe((items) => seen.push(items.length));
    cart.addItem(mug);
    cart.addItem(tee);
    cart.clearCart();
    unsubscribe();
    cart.addItem(mug);
    expect(seen).toEqual([1, 2, 0]);
  });
});
