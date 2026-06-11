import mongoose, { Schema, Document } from 'mongoose'

export interface ILesson extends Document {
  title: string
  description: string
  type: 'video' | 'pdf' | 'quiz' | 'assignment'
  content: string
  duration: number
  order: number
  isFree: boolean
  videoUrl?: string
  pdfUrl?: string
}

export interface IModule extends Document {
  title: string
  description: string
  order: number
  lessons: ILesson[]
}

export interface ICourse extends Document {
  title: string
  slug: string
  description: string
  longDescription: string
  category: mongoose.Types.ObjectId
  subcategory?: mongoose.Types.ObjectId
  instructor: mongoose.Types.ObjectId
  level: 'beginner' | 'intermediate' | 'advanced'
  duration: number
  price: number
  certificateType: 'basic' | 'essential' | 'mastering' | 'diploma' | 'executive' | 'mba'
  certificatePrice: number
  thumbnail: string
  previewVideo?: string
  modules: IModule[]
  requirements: string[]
  learningOutcomes: string[]
  targetAudience: string[]
  isPublished: boolean
  isFree: boolean
  featured: boolean
  rating: number
  totalStudents: number
  totalReviews: number
  language: string
  tags: string[]
  createdAt: Date
  updatedAt: Date
}

const LessonSchema = new Schema<ILesson>({
  title: { type: String, required: true },
  description: { type: String, required: true },
  type: { type: String, enum: ['video', 'pdf', 'quiz', 'assignment'], required: true },
  content: { type: String, required: true },
  duration: { type: Number, required: true },
  order: { type: Number, required: true },
  isFree: { type: Boolean, default: false },
  videoUrl: { type: String },
  pdfUrl: { type: String },
})

const ModuleSchema = new Schema<IModule>({
  title: { type: String, required: true },
  description: { type: String, required: true },
  order: { type: Number, required: true },
  lessons: [LessonSchema],
})

const CourseSchema = new Schema<ICourse>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, required: true },
    longDescription: { type: String, required: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategory: { type: Schema.Types.ObjectId, ref: 'Subcategory' },
    instructor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], required: true },
    duration: { type: Number, required: true },
    price: { type: Number, default: 0 },
    certificateType: { 
      type: String, 
      enum: ['basic', 'essential', 'mastering', 'diploma', 'executive', 'mba'],
      required: true 
    },
    certificatePrice: { type: Number, required: true },
    thumbnail: { type: String, required: true },
    previewVideo: { type: String },
    modules: [ModuleSchema],
    requirements: [{ type: String }],
    learningOutcomes: [{ type: String }],
    targetAudience: [{ type: String }],
    isPublished: { type: Boolean, default: false },
    isFree: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    rating: { type: Number, default: 0 },
    totalStudents: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    language: { type: String, default: 'English' },
    tags: [{ type: String }],
  },
  { timestamps: true }
)

// Index for search
CourseSchema.index({ title: 'text', description: 'text', tags: 'text' })

export const Course = mongoose.model<ICourse>('Course', CourseSchema)