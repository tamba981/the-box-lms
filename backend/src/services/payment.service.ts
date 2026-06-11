import Stripe from 'stripe'
import { Payment } from '../models/Payment.model'
import { CertificateService } from './certificate.service'
import { Enrollment } from '../models/Enrollment.model'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

export class PaymentService {
  static async createCertificatePayment(
    userId: string,
    enrollmentId: string,
    amount: number
  ) {
    try {
      const enrollment = await Enrollment.findById(enrollmentId)
      if (!enrollment) {
        throw new Error('Enrollment not found')
      }

      // Create Stripe payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: 'usd',
        metadata: {
          userId,
          enrollmentId,
          type: 'certificate',
        },
      })

      // Create payment record
      const payment = await Payment.create({
        transactionId: `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        user: userId,
        amount,
        currency: 'USD',
        type: 'certificate',
        itemId: enrollmentId,
        itemType: 'Enrollment',
        paymentMethod: 'stripe',
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
      })

      return {
        clientSecret: paymentIntent.client_secret,
        paymentId: payment._id,
      }
    } catch (error) {
      console.error('Payment creation error:', error)
      throw new Error('Failed to create payment')
    }
  }

  static async handleWebhook(event: Stripe.Event) {
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        await this.confirmPayment(paymentIntent.id)
        break
      case 'payment_intent.payment_failed':
        const failedIntent = event.data.object as Stripe.PaymentIntent
        await this.failPayment(failedIntent.id)
        break
    }
  }

  static async confirmPayment(paymentIntentId: string) {
    const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId })
    if (!payment) return

    payment.status = 'completed'
    await payment.save()

    // Generate certificate if payment is for certificate
    if (payment.type === 'certificate') {
      const enrollment = await Enrollment.findById(payment.itemId)
      if (enrollment && !enrollment.certificateIssued) {
        await CertificateService.generateCertificate(
          payment.user.toString(),
          enrollment.course.toString(),
          enrollment._id.toString(),
          enrollment.certificateType
        )
      }
    }
  }

  static async failPayment(paymentIntentId: string) {
    const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId })
    if (payment) {
      payment.status = 'failed'
      await payment.save()
    }
  }

  static async getUserPayments(userId: string) {
    return Payment.find({ user: userId }).sort({ createdAt: -1 })
  }
}