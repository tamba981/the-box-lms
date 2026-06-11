import mongoose, { Schema, Document } from 'mongoose'

export interface IMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
}

export interface IAIConversation extends Document {
  user: mongoose.Types.ObjectId
  sessionId: string
  messages: IMessage[]
  context: {
    courseId?: mongoose.Types.ObjectId
    topic?: string
    difficulty?: string
  }
  totalTokens: number
  isActive: boolean
  lastActivity: Date
  createdAt: Date
  updatedAt: Date
}

const MessageSchema = new Schema<IMessage>({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
})

const AIConversationSchema = new Schema<IAIConversation>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },
    messages: [MessageSchema],
    context: {
      courseId: { type: Schema.Types.ObjectId, ref: 'Course' },
      topic: { type: String },
      difficulty: { type: String },
    },
    totalTokens: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    lastActivity: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

AIConversationSchema.index({ user: 1, sessionId: 1 })
AIConversationSchema.index({ lastActivity: 1 })

export const AIConversation = mongoose.model<IAIConversation>('AIConversation', AIConversationSchema)