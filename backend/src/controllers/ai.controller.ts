import { Request, Response } from 'express'
import { AIService } from '../services/ai.service'
import { ApiResponse } from '../utils/apiResponse'

export const tutorChat = async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body
    const userId = req.user.id

    const result = await AIService.tutorChat(userId, message, context)
    res.json(ApiResponse.success(result))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to process chat'))
  }
}

export const getRecommendations = async (req: Request, res: Response) => {
  try {
    const userId = req.user.id
    const limit = parseInt(req.query.limit as string) || 10

    const recommendations = await AIService.getRecommendations(userId, limit)
    res.json(ApiResponse.success(recommendations))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to get recommendations'))
  }
}

export const generateQuiz = async (req: Request, res: Response) => {
  try {
    const { topic, difficulty, count } = req.body

    const questions = await AIService.generateQuizQuestions(topic, difficulty, count || 5)
    res.json(ApiResponse.success(questions))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to generate quiz'))
  }
}

export const generateStudyPlan = async (req: Request, res: Response) => {
  try {
    const { courseId, availableHours } = req.body

    const plan = await AIService.generateStudyPlan(courseId, availableHours)
    res.json(ApiResponse.success(plan))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to generate study plan'))
  }
}

export const getInsights = async (req: Request, res: Response) => {
  try {
    const { courseId } = req.params
    const userId = req.user.id

    const insights = await AIService.getLearningInsights(userId, courseId)
    res.json(ApiResponse.success(insights))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to get insights'))
  }
}