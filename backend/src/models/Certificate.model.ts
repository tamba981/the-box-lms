import mongoose, { Schema, Document } from 'mongoose'

export interface ICertificate extends Document {
  certificateNumber: string
  student: mongoose.Types.ObjectId
  course: mongoose.Types.ObjectId
  enrollment: mongoose.Types.ObjectId
  type: 'basic' | 'essential' | 'mastering' | 'diploma' | 'executive' | 'mba'
  studentName: string
  courseTitle: string
  issueDate: Date
  expiryDate?: Date
  grade?: string
  score?: number
  blockchainHash?: string
  qrCode: string
  pdfUrl: string
  isVerified: boolean
  verificationCount: number
  createdAt: Date
  updatedAt: Date
}

const CertificateSchema = new Schema<ICertificate>(
  {
    certificateNumber: { type: String, required: true, unique: true },
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    enrollment: { type: Schema.Types.ObjectId, ref: 'Enrollment', required: true },
    type: { 
      type: String, 
      enum: ['basic', 'essential', 'mastering', 'diploma', 'executive', 'mba'],
      required: true 
    },
    studentName: { type: String, required: true },
    courseTitle: { type: String, required: true },
    issueDate: { type: Date, default: Date.now },
    expiryDate: { type: Date },
    grade: { type: String },
    score: { type: Number },
    blockchainHash: { type: String },
    qrCode: { type: String, required: true },
    pdfUrl: { type: String, required: true },
    isVerified: { type: Boolean, default: true },
    verificationCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

// Index for quick lookup
CertificateSchema.index({ certificateNumber: 1 })
CertificateSchema.index({ student: 1 })
CertificateSchema.index({ blockchainHash: 1 })

export const Certificate = mongoose.model<ICertificate>('Certificate', CertificateSchema)