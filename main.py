import os
import httpx
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import List, Optional
from google import genai
from ollama import Client as OllamaClient

app = FastAPI(title="DeepCode Team API")

# --- КОНФИГУРАЦИЯ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ---
HF_TOKEN = os.getenv("HF_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY")
SHARED_API_KEY = os.getenv("SHARED_API_KEY", "sk-deepcode-v3") # Резервный ключ

# --- МОДЕЛИ И РОЛИ АГЕНТОВ ---
AGENTS = {
    "kimi": {
        "name": "Qwen Coder (Lead Dev)",
        "role": "system",
        "content": "Ты Lead Developer команды DeepCode. Твоя задача — писать чистый, эффективный и рабочий код. Всегда предоставляй полные примеры кода с комментариями.",
        "provider": "hf",
        "model_id": "Qwen/Qwen2.5-Coder-32B-Instruct"
    },
    "groq": {
        "name": "Llama Reviewer",
        "role": "system",
        "content": "Ты Senior Code Reviewer. Твоя задача — искать баги, уязвимости и нарушения best practices в коде от Lead Dev. Будь критичен, но конструктивен.",
        "provider": "groq",
        "model_id": "llama3-70b-8192"
    },
    "gemini": {
        "name": "Gemini Optimizer",
        "role": "system",
        "content": "Ты Technical Writer & Optimizer. Улучшай читаемость кода, пиши документацию и предлагай оптимизации производительности.",
        "provider": "gemini",
        "model_id": "gemini-2.5-pro-exp-03-25" # Актуальная версия на июнь 2026
    },
    "ollama": {
        "name": "Ollama Architect",
        "role": "system",
        "content": "Ты System Architect. Оценивай архитектуру решения, масштабируемость и соответствие требованиям. Дай финальное одобрение или верни на доработку.",
        "provider": "ollama",
        "model_id": "gpt-oss:120b-cloud"
    }
}

# --- КЛИЕНТЫ API ---
gemini_client = genai.Client(api_key=GEMINI_API_KEY)
ollama_client = OllamaClient(
    host="https://ollama.com",
    headers={'Authorization': f'Bearer {OLLAMA_API_KEY}'}
)

# --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ЗАПРОСОВ ---

async def call_hf(model_id: str, messages: list) -> str:
    url = f"https://api-inference.huggingface.co/models/{model_id}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"model": model_id, "messages": messages, "temperature": 0.7}
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise Exception(f"HF Error: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"]

async def call_groq(model_id: str, messages: list) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    payload = {"model": model_id, "messages": messages, "temperature": 0.7}
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise Exception(f"Groq Error: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"]

async def call_gemini(model_id: str, messages: list) -> str:
    # Конвертация формата OpenAI в формат Gemini
    gemini_messages = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model" if m["role"] == "assistant" else "user"
        if m["role"] == "system":
            gemini_messages.append({"role": "user", "parts": [{"text": f"SYSTEM: {m['content']}"}]})
        else:
            gemini_messages.append({"role": role, "parts": [{"text": m["content"]}]})
            
    response = gemini_client.models.generate_content(
        model=model_id,
        contents=gemini_messages,
        config={"temperature": 0.7}
    )
    return response.text

async def call_ollama(model_id: str, messages: list) -> str:
    # Ollama Python client уже умеет работать с облаком через настроенный хост
    response = ollama_client.chat(model=model_id, messages=messages, stream=False)
    return response['message']['content']

# --- ОСНОВНАЯ ЛОГИКА КОМАНДЫ ---

async def run_team_discussion(user_query: str, rounds: int = 2) -> str:
    """Запускает обсуждение между агентами и возвращает финальный ответ."""
    
    # Инициализация истории сообщений для каждого агента
    history = {name: [{"role": "system", "content": agent["content"]}] for name, agent in AGENTS.items()}
    
    # Добавляем запрос пользователя всем
    user_msg = {"role": "user", "content": user_query}
    for h in history.values():
        h.append(user_msg)

    current_speaker_order = ["kimi", "groq", "gemini", "ollama"]
    
    last_response = ""
    
    for r in range(rounds):
        for agent_name in current_speaker_order:
            agent = AGENTS[agent_name]
            provider = agent["provider"]
            
            # Вызываем нужного провайдера
            if provider == "hf":
                last_response = await call_hf(agent["model_id"], history[agent_name])
            elif provider == "groq":
                last_response = await call_groq(agent["model_id"], history[agent_name])
            elif provider == "gemini":
                last_response = await call_gemini(agent["model_id"], history[agent_name])
            elif provider == "ollama":
                last_response = await call_ollama(agent["model_id"], history[agent_name])
            
            # Добавляем ответ текущего агента в историю ВСЕХ остальных агентов
            assistant_msg = {"role": "assistant", "content": last_response}
            for other_name in current_speaker_order:
                if other_name != agent_name:
                    history[other_name].append(assistant_msg)
                    
            # Добавляем ответ в историю самого агента (для контекста следующего раунда)
            history[agent_name].append(assistant_msg)

    # Финальный синтез ответа от Архитектора (Ollama)
    synthesis_prompt = (
        "На основе всего обсуждения выше, предоставь ПОЛНЫЙ, ГОТОВЫЙ К ИСПОЛЬЗОВАНИЮ ФИНАЛЬНЫЙ ОТВЕТ пользователю. "
        "Не упоминай внутреннее обсуждение, роли или имена агентов. Ответ должен выглядеть как ответ одной супер-нейросети. "
        "Если был написан код, включи его полностью."
    )
    history["ollama"].append({"role": "user", "content": synthesis_prompt})
    final_answer = await call_ollama(AGENTS["ollama"]["model_id"], history["ollama"])
    
    return final_answer

# --- OPENAI COMPATIBLE ENDPOINT ---

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str = "deepcode-team"
    messages: List[ChatMessage]
    temperature: float = 0.7
    max_tokens: Optional[int] = None

@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest, authorization: str = Header(None)):
    # 1. Проверка API ключа
    if not authorization or authorization.replace("Bearer ", "") != SHARED_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API Key")

    # 2. Извлекаем последний пользовательский запрос
    user_messages = [m for m in request.messages if m.role == "user"]
    if not user_messages:
        raise HTTPException(status_code=400, detail="No user message found")
        
    user_query = user_messages[-1].content

    try:
        # 3. Запускаем команду
        final_response = await run_team_discussion(user_query, rounds=2)
        
        # 4. Формируем ответ в формате OpenAI
        return {
            "id": "chatcmpl-deepcode-" + str(hash(final_response))[:8],
            "object": "chat.completion",
            "created": int(__import__('time').time()),
            "model": request.model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": final_response
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 0, # Сложно посчитать точно при мульти-агенте
                "completion_tokens": 0,
                "total_tokens": 0
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Team Discussion Failed: {str(e)}")

@app.get("/")
async def root():
    return {"status": "DeepCode Team API is running", "key_required": "sk-deepcode-v3"}
