import mongoose, { Schema, Document } from 'mongoose'

export interface IEnrollment extends Document {
  student: mongoose.Types.ObjectId
  course: mongoose.Types.ObjectId
  status: 'active' | 'completed' | 'dropped' | 'suspended'
  progress: number
  completedLessons: mongoose.Types.ObjectId[]
  startedAt: Date
  completedAt?: Date
  lastAccessedAt: Date
  certificateIssued: boolean
  certificateId?: string
  paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded'
  paymentAmount: number
  certificateType: string
  createdAt: Date
  updatedAt: Date
}

const EnrollmentSchema = new Schema<IEnrollment>(
  {
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    status: { 
      type: String, 
      enum: ['active', 'completed', 'dropped', 'suspended'],
      default: 'active' 
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    completedLessons: [{ type: Schema.Types.ObjectId }],
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    lastAccessedAt: { type: Date, default: Date.now },
    certificateIssued: { type: Boolean, default: false },
    certificateId: { type: String },
    paymentStatus: { 
      type: String, 
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending' 
    },
    paymentAmount: { type: Number, default: 0 },
    certificateType: { type: String, required: true },
  },
  { timestamps: true }
)

// Compound index for unique enrollment per student per course
EnrollmentSchema.index({ student: 1, course: 1 }, { unique: true })

export const Enrollment = mongoose.model<IEnrollment>('Enrollment', EnrollmentSchema)