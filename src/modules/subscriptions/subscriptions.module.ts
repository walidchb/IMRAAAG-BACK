import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SubscriptionPlan,
  SubscriptionPlanSchema,
} from './schemas/subscription-plan.schema';
import { Subscription, SubscriptionSchema } from './schemas/subscription.schema';
import {
  SubscriptionEvent,
  SubscriptionEventSchema,
} from './schemas/subscription-event.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { StoreMember, StoreMemberSchema } from '../team/schemas/store-member.schema';
import {
  StoreInvitation,
  StoreInvitationSchema,
} from '../team/schemas/store-invitation.schema';
import { PosHold, PosHoldSchema } from '../orders/schemas/pos-hold.schema';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionAccessService } from './subscription-access.service';

/**
 * Plans & Subscriptions (leaf module).
 *
 * Deliberately does **not** import `StoresModule`/`OrdersModule`/`ProductsModule`: it registers
 * the read-only models it needs (products/team/invitations/pos-holds) directly and receives a
 * store id from callers, so the dependency graph stays acyclic
 * (`SubscriptionsModule` ← stores/products/orders/team/pos). See plan §15.1.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SubscriptionPlan.name, schema: SubscriptionPlanSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: SubscriptionEvent.name, schema: SubscriptionEventSchema },
      { name: Product.name, schema: ProductSchema },
      { name: StoreMember.name, schema: StoreMemberSchema },
      { name: StoreInvitation.name, schema: StoreInvitationSchema },
      { name: PosHold.name, schema: PosHoldSchema },
    ]),
  ],
  providers: [PlansService, SubscriptionsService, SubscriptionAccessService],
  exports: [PlansService, SubscriptionsService, SubscriptionAccessService, MongooseModule],
})
export class SubscriptionsModule {}
