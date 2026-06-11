import OpenAI from 'openai'
import { AIConversation } from '../models/AIConversation.model'
import { Course } from '../models/Course.model'
import { User } from '../models/User.model'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export class AIService {
  // AI Tutor Chat
  static async tutorChat(userId: string, message: string, context?: any) {
    try {
      // Get or create conversation
      let conversation = await AIConversation.findOne({
        user: userId,
        isActive: true,
      })

      if (!conversation) {
        conversation = await AIConversation.create({
          user: userId,
          sessionId: crypto.randomUUID(),
          messages: [],
          context: context || {},
        })
      }

      // Add user message
      conversation.messages.push({
        role: 'user',
        content: message,
        timestamp: new Date(),
      })

      // Prepare system prompt
      const systemPrompt = `You are an AI tutor for The BOX learning platform. 
      Your role is to help students learn effectively. Be helpful, patient, and educational.
      Provide clear explanations, examples, and encourage critical thinking.
      Current context: ${JSON.stringify(conversation.context)}`

      // Get AI response
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversation.messages.slice(-10).map(m => ({
            role: m.role,
            content: m.content,
          })),
        ],
        temperature: 0.7,
        max_tokens: 500,
      })

      const aiResponse = completion.choices[0].message.content

      // Add AI response
      conversation.messages.push({
        role: 'assistant',
        content: aiResponse!,
        timestamp: new Date(),
      })

      conversation.totalTokens += completion.usage?.total_tokens || 0
      conversation.lastActivity = new Date()
      await conversation.save()

      return {
        response: aiResponse,
        conversationId: conversation._id,
      }
    } catch (error) {
      console.error('AI Tutor Error:', error)
      throw new Error('Failed to get AI response')
    }
  }

  // Course Recommendations
  static async getRecommendations(userId: string, limit: number = 10) {
    try {
      const user = await User.findById(userId)
      const userEnrollments = await AIConversation.find({ user: userId }).limit(5)

      // Get user's interests from conversations
      const interests = userEnrollments
        .flatMap(e => e.messages)
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join(' ')

      // Get courses based on interests and popular courses
      const recommendedCourses = await Course.find({
        isPublished: true,
        isFree: true,
      })
        .sort({ totalStudents: -1, rating: -1 })
        .limit(limit)
        .populate('instructor', 'firstName lastName')
        .populate('category', 'name')

      return recommendedCourses
    } catch (error) {
      console.error('Recommendation Error:', error)
      return []
    }
  }

  // Generate Quiz Questions
  static async generateQuizQuestions(topic: string, difficulty: string, count: number = 5) {
    try {
      const prompt = `Generate ${count} multiple choice quiz questions about "${topic}" at ${difficulty} level.
      Format as JSON array with objects containing: question, options (array of 4), correctAnswer (0-3), explanation.
      Make questions educational and appropriate.`

      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a quiz generator for an educational platform.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 1000,
      })

      const response = completion.choices[0].message.content
      const questions = JSON.parse(response || '[]')

      return questions
    } catch (error) {
      console.error('Quiz Generation Error:', error)
      return []
    }
  }

  // Study Plan Generator
  static async generateStudyPlan(courseId: string, availableHours: number) {
    try {
      const course = await Course.findById(courseId)
      if (!course) throw new Error('Course not found')

      const totalDuration = course.duration
      const daysNeeded = Math.ceil(totalDuration / availableHours)

      const plan = {
        courseTitle: course.title,
        totalHours: totalDuration,
        hoursPerDay: availableHours,
        estimatedDays: daysNeeded,
        weeklySchedule: [],
        tips: [
          'Set specific daily goals',
          'Take breaks every 45 minutes',
          'Review previous material regularly',
          'Practice with quizzes and assignments',
        ],
      }

      // Generate daily schedule
      for (let i = 1; i <= Math.min(daysNeeded, 7); i++) {
        plan.weeklySchedule.push({
          day: i,
          focus: `Module ${Math.ceil(i * (course.modules.length / daysNeeded)) || 1}`,
          hours: availableHours,
        })
      }

      return plan
    } catch (error) {
      console.error('Study Plan Error:', error)
      throw new Error('Failed to generate study plan')
    }
  }

  // Learning Analytics Insights
  static async getLearningInsights(userId: string, courseId: string) {
    try {
      const user = await User.findById(userId)
      const enrollment = await Enrollment.findOne({ student: userId, course: courseId })

      if (!enrollment) throw new Error('Enrollment not found')

      const insightPrompt = `Analyze this student's learning progress:
      - Progress: ${enrollment.progress}%
      - Completed lessons: ${enrollment.completedLessons.length}
      - Started: ${enrollment.startedAt}
      
      Provide personalized learning advice and predictions.`

      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a learning analytics expert.' },
          { role: 'user', content: insightPrompt },
        ],
        temperature: 0.7,
        max_tokens: 300,
      })

      return {
        insights: completion.choices[0].message.content,
        progress: enrollment.progress,
        predictedCompletion: this.estimateCompletionDate(enrollment),
      }
    } catch (error) {
      console.error('Insights Error:', error)
      return null
    }
  }

  private static estimateCompletionDate(enrollment: any): Date {
    const avgProgressPerDay = enrollment.progress / 
      ((Date.now() - enrollment.startedAt) / (1000 * 60 * 60 * 24))
    const remainingDays = (100 - enrollment.progress) / avgProgressPerDay
    return new Date(Date.now() + remainingDays * 24 * 60 * 60 * 1000)
  }
}