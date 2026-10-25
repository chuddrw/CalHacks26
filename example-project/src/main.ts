// Compose the owners' modules around the single shared cart instance.
import { cart } from './cart/cart';
import { mountCart } from './cart/cartView';
import { mountCatalog } from './catalog/catalog';
import { PRODUCTS } from './catalog/products';
import { initializeCheckout, openCheckout } from './checkout/checkout.js';
import { mountCartRemoval } from './removal/removal';
import './removal/removal.css';
import './shop.css';

const catalogRoot = document.querySelector<HTMLElement>('#catalog');
const cartRoot = document.querySelector<HTMLElement>('#cart');
if (!catalogRoot || !cartRoot) throw new Error('The shopping app requires catalog and cart containers.');

initializeCheckout(cart);
const removal = mountCartRemoval(cartRoot, cart);
mountCart(cartRoot, cart, { openCheckout, afterRender: removal.afterRender });
mountCatalog(catalogRoot, PRODUCTS, product => cart.addItem(product));
