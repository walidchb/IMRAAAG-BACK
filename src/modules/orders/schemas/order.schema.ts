import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { OrderStatus, ORDER_STATUS_VALUES } from '../../../common/constants/order-statuses.const';

export type OrderDocument = Order & Document;

@Schema()
export class Order {
  @Prop({ required: true, unique: true })
  orderNo: string;

  @Prop({ required: true })
  vendorEmail: string;

  @Prop({ type: Date })
  date: Date;

  @Prop({ type: Date })
  createdAt: Date;

  @Prop()
  createdBy: string;

  @Prop({ type: Date })
  confirmedAt: Date;

  @Prop()
  confirmedBy: string;

  @Prop({ type: Date })
  dispatchedAt: Date;

  @Prop()
  statusConfirmation: string;

  @Prop([{
    productId: { type: String },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    variantDetails: { type: String },
    weight: { type: Number }
  }])
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    variantDetails?: string;
    weight?: number;
  }>;

  @Prop({
    type: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String },
      wilaya: { type: String, required: true },
      commune: { type: String, required: true },
      address: { type: String },
      note: { type: String }
    }
  })
  customer: {
    name: string;
    phone: string;
    email: string;
    wilaya: string;
    commune: string;
    address: string;
    note?: string;
  };

  @Prop({ required: true })
  total: number;

  @Prop({ type: String, enum: ORDER_STATUS_VALUES, required: true })
  status: OrderStatus;

  @Prop({ default: 'COD' })
  paymentMethod: string;

  @Prop({ type: String, enum: ['stopdesk', 'home'], required: true })
  shippingMethod: string;

  @Prop()
  bureau: string;

  @Prop()
  shippingFee: number;

  @Prop()
  deliveryCompanyId: string;

  @Prop()
  deliveryParcelId: string;

  @Prop()
  deliveryError: string;

  @Prop()
  stopDeskCode: string;

  @Prop([{
    status: { type: String, enum: ORDER_STATUS_VALUES },
    date: { type: Date },
    user: { type: String }
  }])
  history: Array<{ status: OrderStatus; date: Date; user: string }>;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ orderNo: 1 });
OrderSchema.index({ vendorEmail: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ createdAt: -1 });
