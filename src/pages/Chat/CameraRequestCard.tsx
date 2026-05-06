import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CAMERA_REQUEST_ACCEPTED_UI_EVENT, type CameraRequestDetail } from '../../../shared/camera-request';
import { useChatStore } from '@/stores/chat';

export function CameraRequestCard({ request }: { request: CameraRequestDetail }) {
  const acceptCameraRequest = useChatStore((state) => state.acceptCameraRequest);
  const declineCameraRequest = useChatStore((state) => state.declineCameraRequest);

  if (request.status === 'declined') {
    return (
      <Card className="w-full max-w-lg rounded-2xl border border-black/10 bg-muted/40 p-4 text-sm text-muted-foreground">
        已取消本次拍照请求
      </Card>
    );
  }

  if (request.status === 'accepted') {
    return (
      <Card className="w-full max-w-lg rounded-2xl border border-black/10 bg-muted/40 p-4 text-sm text-muted-foreground">
        已打开摄像头请求
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg rounded-3xl border border-black/10 bg-white/95 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#0a84ff]/10 text-[#0a84ff]">
          <Camera className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-foreground">Agent 请求你拍一张照片</h3>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            KTClaw 只会在你确认后打开摄像头，不会录音，也不会自动发送。
          </p>
          {request.reason ? (
            <p className="mt-2 rounded-2xl bg-black/5 px-3 py-2 text-[12px] leading-5 text-foreground/80">
              {request.reason}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              className="rounded-full bg-[#0a84ff] px-4 text-white hover:bg-[#0074eb]"
              onClick={() => {
                acceptCameraRequest(request.id);
                window.dispatchEvent(new CustomEvent(CAMERA_REQUEST_ACCEPTED_UI_EVENT, {
                  detail: request,
                }));
              }}
            >
              打开摄像头
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="rounded-full border border-black/10 bg-white px-4 text-foreground hover:bg-black/5"
              onClick={() => declineCameraRequest(request.id)}
            >
              暂不拍照
            </Button>
          </div>
        </div>
        <X className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
    </Card>
  );
}
