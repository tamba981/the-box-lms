import mongoose, { Schema, Document } from 'mongoose'

export interface IPayment extends Document {
  transactionId: string
  user: mongoose.Types.ObjectId
  amount: number
  currency: string
  type: 'certificate' | 'course' | 'diploma' | 'subscription' | 'donation'
  itemId: mongoose.Types.ObjectId
  itemType: string
  paymentMethod: 'stripe' | 'paypal' | 'mobile_money'
  status: 'pending' | 'completed' | 'failed' | 'refunded'
  stripePaymentIntentId?: string
  paypalOrderId?: string
  metadata?: Record<string, any>
  receiptUrl?: string
  refundAmount?: number
  refundReason?: string
  refundedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const PaymentSchema = new Schema<IPayment>(
  {
    transactionId: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    type: { 
      type: String, 
      enum: ['certificate', 'course', 'diploma', 'subscription', 'donation'],
      required: true 
    },
    itemId: { type: Schema.Types.ObjectId, required: true },
    itemType: { type: String, required: true },
    paymentMethod: { 
      type: String, 
      enum: ['stripe', 'paypal', 'mobile_money'],
      required: true 
    },
    status: { 
      type: String, 
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending' 
    },
    stripePaymentIntentId: { type: String },
    paypalOrderId: { type: String },
    metadata: { type: Schema.Types.Mixed },
    receiptUrl: { type: String },
    refundAmount: { type: Number },
    refundReason: { type: String },
    refundedAt: { type: Date },
  },
  { timestamps: true }
)

// Indexes
PaymentSchema.index({ transactionId: 1 })
PaymentSchema.index({ user: 1 })
PaymentSchema.index({ status: 1 })

export const Payment = mongoose.model<IPayment>('Payment', PaymentSchema)