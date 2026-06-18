import asyncio
import httpx

# --- KEEP-ALIVE ДЛЯ RENDER ---
async def keep_alive():
    """Отправляет запрос сам себе каждые 11 минут, чтобы Render не засыпал."""
    while True:
        try:
            async with httpx.AsyncClient() as client:
                # Запрос к корневому эндпоинту (самый легкий)
                await client.get("http://localhost:10000/", timeout=5.0)
                print(" Keep-alive ping sent successfully")
        except Exception as e:
            print(f"⚠️ Keep-alive failed: {e}")
        
        # Ждем 11 минут (660 секунд). 
        # Render усыпляет через 15 мин, так что 11 мин — безопасный запас.
        await asyncio.sleep(660)

# Запускаем фоновую задачу при старте приложения
@app.on_event("startup")
async def startup_event():
    asyncio.create_task(keep_alive())
    print("✅ Keep-alive task started. Service will stay awake.")




import os
import httpx
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import List, Optional
from google import genai
from ollama import Client as OllamaClient

app = FastAPI(title="DeepCode Team API")

# --- КОНФИГУРАЦИЯ ---
HF_TOKEN = os.getenv("HF_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY")
SHARED_API_KEY = os.getenv("SHARED_API_KEY", "sk-deepcode-v3")

# --- РОЛИ АГЕНТОВ ---
AGENTS = {
    "kimi": {
        "name": "Qwen Coder (Lead Dev)",
        "role": "system",
        "content": "Ты Lead Developer команды DeepCode. Пиши чистый, эффективный код с комментариями.",
        "provider": "hf",
        "model_id": "Qwen/Qwen2.5-Coder-32B-Instruct"
    },
    "groq": {
        "name": "Llama Reviewer",
        "role": "system",
        "content": "Ты Senior Code Reviewer. Ищи баги и уязвимости. Будь критичен.",
        "provider": "groq",
        "model_id": "llama3-70b-8192"
    },
    "gemini": {
        "name": "Gemini Optimizer",
        "role": "system",
        "content": "Ты Technical Writer. Улучшай читаемость и пиши документацию.",
        "provider": "gemini",
        "model_id": "gemini-2.5-pro-exp-03-25"
    },
    "ollama": {
        "name": "Ollama Architect",
        "role": "system",
        "content": "Ты System Architect. Оценивай архитектуру и давай финальное одобрение.",
        "provider": "ollama",
        "model_id": "gpt-oss:120b-cloud"
    }
}

# --- КЛИЕНТЫ ---
gemini_client = genai.Client(api_key=GEMINI_API_KEY)
ollama_client = OllamaClient(
    host="https://ollama.com",
    headers={'Authorization': f'Bearer {OLLAMA_API_KEY}'}
)

# --- ФУНКЦИИ ВЫЗОВА API ---

async def call_hf(model_id: str, messages: list) -> str:
    url = f"https://api-inference.huggingface.co/models/{model_id}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, json={"model": model_id, "messages": messages}, headers=headers)
        if resp.status_code != 200: raise Exception(f"HF Error: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"]

async def call_groq(model_id: str, messages: list) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json={"model": model_id, "messages": messages}, headers=headers)
        if resp.status_code != 200: raise Exception(f"Groq Error: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"]

async def call_gemini(model_id: str, messages: list) -> str:
    gemini_msgs = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model" if m["role"] == "assistant" else "user"
        content = f"SYSTEM: {m['content']}" if m["role"] == "system" else m["content"]
        gemini_msgs.append({"role": role, "parts": [{"text": content}]})
    
    response = gemini_client.models.generate_content(
        model=model_id, contents=gemini_msgs, config={"temperature": 0.7}
    )
    return response.text

async def call_ollama(model_id: str, messages: list) -> str:
    response = ollama_client.chat(model=model_id, messages=messages, stream=False)
    return response['message']['content']

# --- ЛОГИКА КОМАНДЫ ---

async def run_team_discussion(user_query: str, rounds: int = 2) -> str:
    history = {name: [{"role": "system", "content": agent["content"]}] for name, agent in AGENTS.items()}
    user_msg = {"role": "user", "content": user_query}
    for h in history.values(): h.append(user_msg)

    order = ["kimi", "groq", "gemini", "ollama"]
    last_response = ""
    
    for _ in range(rounds):
        for agent_name in order:
            agent = AGENTS[agent_name]
            provider = agent["provider"]
            
            if provider == "hf": last_response = await call_hf(agent["model_id"], history[agent_name])
            elif provider == "groq": last_response = await call_groq(agent["model_id"], history[agent_name])
            elif provider == "gemini": last_response = await call_gemini(agent["model_id"], history[agent_name])
            elif provider == "ollama": last_response = await call_ollama(agent["model_id"], history[agent_name])
            
            assistant_msg = {"role": "assistant", "content": last_response}
            for other in order:
                if other != agent_name: history[other].append(assistant_msg)
            history[agent_name].append(assistant_msg)

    # Финальный синтез
    synthesis_prompt = "Предоставь ПОЛНЫЙ ФИНАЛЬНЫЙ ОТВЕТ пользователю на основе обсуждения выше. Не упоминай агентов или внутреннюю переписку. Если есть код — включи его полностью."
    history["ollama"].append({"role": "user", "content": synthesis_prompt})
    return await call_ollama(AGENTS["ollama"]["model_id"], history["ollama"])

# --- ENDPOINT ---

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    model: str = "deepcode-team"
    messages: List[ChatMessage]

@app.post("/v1/chat/completions")
async def chat(request: ChatRequest, authorization: str = Header(None)):
    if not authorization or authorization.replace("Bearer ", "") != SHARED_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API Key")
    
    user_msgs = [m for m in request.messages if m.role == "user"]
    if not user_msgs: raise HTTPException(status_code=400, detail="No user message")
    
    try:
        final_answer = await run_team_discussion(user_msgs[-1].content, rounds=2)
        return {
            "id": "chatcmpl-deepcode", "object": "chat.completion",
            "created": int(__import__('time').time()), "model": request.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": final_answer}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
async def root():
    return {"status": "DeepCode Team API Running", "key": "sk-deepcode-v3"}
