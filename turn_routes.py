"""Narrow owner-only turn controls. Never spawn or resume a second executor."""
from fastapi import HTTPException
from pydantic import BaseModel


class TurnControl(BaseModel):
    threadId: str
    turnId: str


def register_turn_routes(app, shared, ensure_shared):
    async def operate(body, operation):
        await ensure_shared(body.threadId)
        if not shared.enabled(body.threadId):
            raise HTTPException(409, '暂停和继续需要双端共用连接')
        try:
            result = await shared.adapter.call(operation, body.threadId, turnId=body.turnId)
            await shared.probe(body.threadId)
            return result
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(409, str(exc))

    @app.post('/api/turn/pause')
    async def pause(body: TurnControl):
        return await operate(body, 'pause-turn')

    @app.post('/api/turn/resume')
    async def resume(body: TurnControl):
        return await operate(body, 'resume-turn')
