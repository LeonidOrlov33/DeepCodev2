import os
import time
import asyncio
import traceback
import httpx
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import List

# --- ИНИЦИАЛИЗАЦИЯ ---
app = FastAPI(title="DeepCode Team API (Turbo)")

# --- КОНФИГУРАЦИЯ ---
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SHARED_API_KEY = os.getenv("SHARED_API_KEY", "sk-deepcode-v3")

# --- РОЛИ АГЕНТОВ (АКТУАЛЬНЫЕ МОДЕЛИ GROQ ИЮНЬ 2026) ---
AGENTS = {
    "coder": {
        "name": "Llama 3.1 Instant Coder",
        "system": "Ты эксперт по Python. Пиши чистый, рабочий код с комментариями. Отвечай только кодом и кратким пояснением.",
        "model": "llama-3.1-8b-instant"
    },
    "reviewer": {
        "name": "Llama 3.3 Reviewer", 
        "system": "Ты Senior Code Reviewer. Найди баги, уязвимости и предложи исправления. Будь краток.",
        "model": "llama-3.3-70b-versatile"
    },
    "architect": {
        "name": "Llama 3.3 Architect",
        "system": "Ты System Architect. Собери финальный ответ: исправленный код + объяснение. Не упоминай внутреннее обсуждение или роли агентов.",
        "model": "llama-3.3-70b-versatile"
    }
}

# --- ФУНКЦИЯ ВЫЗОВА GROQ ---
async def call_groq(model_id: str, messages: list) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    payload = {"model": model_id, "messages": messages, "temperature": 0.7}
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200: 
            raise Exception(f"Groq Error [{resp.status_code}]: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"]

# --- БЫСТРАЯ ЛОГИКА КОМАНДЫ ---
async def run_team_discussion(user_query: str) -> str:
    print(f"🚀 Turbo Team started for: {user_query[:50]}...")
    
    # 1. Coder пишет черновик (Llama 3.1 8b Instant - мгновенно)
    print("   ⚡ Step 1: Coder generating draft...")
    coder_msgs = [
        {"role": "system", "content": AGENTS["coder"]["system"]},
        {"role": "user", "content": user_query}
    ]
    code_draft = await call_groq(AGENTS["coder"]["model"], coder_msgs)
    print("   ✅ Coder done.")

    # 2. Reviewer проверяет (Llama 3.3 70b)
    print("   ⚡ Step 2: Reviewer checking...")
    reviewer_msgs = [
        {"role": "system", "content": AGENTS["reviewer"]["system"]},
        {"role": "user", "content": f"Задача: {user_query}\n\nКод:\n{code_draft}"},
        {"role": "user", "content": "Найди ошибки и напиши исправленную версию."}
    ]
    review_result = await call_groq(AGENTS["reviewer"]["model"], reviewer_msgs)
    print("   ✅ Reviewer done.")

    # 3. Architect собирает финал
    print("   ⚡ Step 3: Architect synthesizing...")
    arch_msgs = [
        {"role": "system", "content": AGENTS["architect"]["system"]},
        {"role": "user", "content": f"Исходная задача: {user_query}\n\nРезультат проверки и исправлений:\n{review_result}"}
    ]
    final_answer = await call_groq(AGENTS["architect"]["model"], arch_msgs)
    print("   ✅ Final answer ready!")
    
    return final_answer

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
    if not user_msgs: 
        raise HTTPException(status_code=400, detail="No user message")
    
    try:
        start_time = time.time()
        final_answer = await run_team_discussion(user_msgs[-1].content)
        duration = time.time() - start_time
        
        print(f"⏱️ Request completed in {duration:.2f}s")
        
        return {
            "id": "chatcmpl-turbo", 
            "object": "chat.completion",
            "created": int(time.time()), 
            "model": request.model,
            "choices": [{
                "index": 0, 
                "message": {"role": "assistant", "content": final_answer}, 
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }
    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"❌ ERROR: {error_trace}")
        raise HTTPException(status_code=500, detail=str(e)[:300])

@app.get("/")
async def root():
    return {"status": "DeepCode Turbo API Running", "key": "sk-deepcode-v3"}

# --- KEEP-ALIVE ДЛЯ RENDER ---
async def keep_alive():
    """Отправляет запрос сам себе каждые 11 минут, чтобы Render не засыпал."""
    while True:
        try:
            async with httpx.AsyncClient() as client:
                await client.get("http://localhost:10000/", timeout=5.0)
                print("🔔 Keep-alive ping sent successfully")
        except Exception as e:
            print(f"⚠️ Keep-alive failed: {e}")
        
        await asyncio.sleep(660) # 11 минут

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(keep_alive())
    print("✅ Keep-alive task started. Turbo mode active.")
